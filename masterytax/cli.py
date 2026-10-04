"""Command line: `python -m masterytax <command> ...` (see README)."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from decimal import Decimal

from . import taxengine
from .deposits import federal_schedule
from .engine import compute_liabilities, supported_states
from .importer import load_payroll
from .money import fmt
from .payments import NOT_TRANSMITTED, instructions
from .pipeline import Workspace
from .returns import (ReturnDoc, _jsonable, amend_941, state_wage_report, w2_flat, w2_records, w2c_records,
                      w3_reconcile)


def _cell(v) -> str:
    if isinstance(v, Decimal):
        return fmt(v)
    return str(v)


def table(rows: list[list], headers: list[str]) -> str:
    cells = [[_cell(c) for c in r] for r in rows]
    widths = [max([len(h)] + [len(r[i]) for r in cells]) for i, h in enumerate(headers)]
    num = [bool(rows) and all(isinstance(r[i], (Decimal, int)) for r in rows) for i in range(len(headers))]
    def fmt_row(r):
        return "  ".join(c.rjust(w) if num[i] else c.ljust(w) for i, (c, w) in enumerate(zip(r, widths))).rstrip()
    return "\n".join([fmt_row(headers), "  ".join("-" * w for w in widths)] + [fmt_row(r) for r in cells])


def print_doc(doc: ReturnDoc) -> None:
    print(f"Form {doc.form} — {doc.company_name} (FEIN {doc.fein}) — {doc.period}")
    print(table([[l.line, l.label, l.value] for l in doc.lines], ["Line", "Description", "Amount"]))
    for name, rows in doc.schedules.items():
        print(f"\n{name}")
        if rows:
            headers = list(rows[0].keys())
            print(table([[r[h] for h in headers] for r in rows], headers))
    for n in doc.notes:
        print(f"note: {n}")
    print()


def _out(args, payload, render) -> None:
    if args.json:
        json.dump(_jsonable(payload), sys.stdout, indent=2)
        print()
    else:
        render()


def _companies(ws: Workspace, args) -> list[str]:
    return [args.company] if args.company else sorted(ws.companies)


def cmd_validate(ws: Workspace, args) -> int:
    issues = ws.issues
    _out(args, [i.as_dict() for i in issues], lambda: print(
        table([[i.severity, i.code, i.company_id, i.employee_id, i.row or "", i.message] for i in issues],
              ["Severity", "Code", "Company", "Employee", "Row", "Message"]) if issues else "No issues."))
    held = sum(1 for i in issues if i.severity == "error" and i.row)
    if not args.json:
        print(f"\n{len(ws.lines)} payroll rows accepted, {held} held for correction.")
    return 1 if any(i.severity == "error" for i in issues) else 0


def cmd_liabilities(ws: Workspace, args) -> int:
    if args.explain:
        for l in ws.liabilities:
            if l.line.employee_id == args.explain and (not args.company or l.company_id == args.company):
                print(f"{l.pay_date}  {l.trace}")
        return 0
    summary = ws.liability_summary()
    payer = {l.tax_code: l.payer for l in ws.liabilities}
    rows = [[c, g, t, payer[t], amt] for (c, g, t), amt in sorted(summary.items())
            if not args.company or c == args.company]
    _out(args, [dict(zip(["company", "group", "tax", "payer", "amount"], r)) for r in rows],
         lambda: print(table(rows, ["Company", "Deposit group", "Tax", "Paid by", "Liability"])))
    return 0


def cmd_deposits(ws: Workspace, args) -> int:
    rows = []
    for st in ws.statuses:
        o = st.obligation
        if args.company and o.company_id != args.company:
            continue
        rows.append([o.company_id, o.group, o.period, o.due, o.amount, st.paid, st.outstanding, st.status,
                     st.days_late or "", st.penalty if st.penalty else "", o.reason])
    headers = ["Company", "Group", "Period", "Due", "Amount", "Paid", "Outstanding", "Status", "Days late",
               "Est. penalty", "Rule"]

    def render():
        for cid in _companies(ws, args):
            print(f"{cid}: federal deposit schedule = {federal_schedule(ws.companies[cid])}")
        print(table(rows, headers))
        for c in ws.credits:
            print(f"unapplied credit: {c}")
    _out(args, [dict(zip(headers, r)) for r in rows], render)
    return 0


def cmd_941(ws: Workspace, args) -> int:
    docs = [ws.form_941(cid, args.year, args.quarter) for cid in _companies(ws, args)]
    _out(args, [d.as_dict() for d in docs], lambda: [print_doc(d) for d in docs])
    return 0


def cmd_940(ws: Workspace, args) -> int:
    docs = [ws.form_940(cid, args.year) for cid in _companies(ws, args)]
    _out(args, [d.as_dict() for d in docs], lambda: [print_doc(d) for d in docs])
    return 0


def cmd_w2(ws: Workspace, args) -> int:
    recs = [r for r in w2_records(ws.liabilities, args.year) if not args.company or r["company_id"] == args.company]
    recon = {cid: w3_reconcile(ws.companies[cid], ws.liabilities, args.year) for cid in _companies(ws, args)}

    def render():
        boxes = ["box1", "box2", "box3", "box4", "box5", "box6"]
        print(table([[r["company_id"], r["employee_id"], r["name"]] + [r[b] for b in boxes] for r in recs],
                    ["Company", "Employee", "Name"] + boxes))
        for r in recs:
            extra = {k: v for k, v in w2_flat(r).items() if k not in boxes and v}
            if extra:
                print(f"  {r['employee_id']}: " + "; ".join(f"{k} {fmt(v)}" for k, v in extra.items()))
        for cid, (w3, issues) in recon.items():
            print(f"\nW-3 {cid}: " + ", ".join(f"{k}={_cell(v)}" for k, v in w3.items()))
            print("W-2/941 reconciliation: " + ("balanced" if not issues else ""))
            for i in issues:
                print(f"  {i.severity}: {i.message}")
    _out(args, {"w2": recs, "w3": {c: r[0] for c, r in recon.items()},
                "reconciliation": {c: [i.as_dict() for i in r[1]] for c, r in recon.items()}}, render)
    return 1 if any(r[1] for r in recon.values()) else 0


def cmd_state(ws: Workspace, args) -> int:
    st = args.state.upper()
    cids = [cid for cid in _companies(ws, args) if args.company or st in ws.states(cid)]
    docs = [state_wage_report(ws.companies[cid], ws.liabilities, ws.remittance, st, args.year, args.quarter)
            for cid in cids]
    _out(args, [d.as_dict() for d in docs], lambda: [print_doc(d) for d in docs])
    return 0


def cmd_amend(ws: Workspace, args) -> int:
    corrected_lines, issues = load_payroll(args.corrected, ws.companies, supported_states())
    corrected, _, _ = compute_liabilities(corrected_lines, ws.companies, ws.profiles, ws.remittance)
    out = []
    for cid in _companies(ws, args):
        doc = amend_941(ws.companies[cid], ws.liabilities, corrected, args.year, args.quarter)
        w2c = w2c_records(ws.liabilities, corrected, args.year, cid)
        out.append((doc, w2c))

    def render():
        for doc, w2c in out:
            print_doc(doc)
            print("W-2c corrections:" if w2c else "No W-2c needed.")
            for r in w2c:
                print(f"  {r['employee_id']} {r['name']} (xxx-xx-{r['ssn_last4']}): " + "; ".join(
                    f"{b} {fmt(c['previously_reported'])} -> {fmt(c['correct'])}" for b, c in r["changes"].items()))
    _out(args, [{"941x": d.as_dict(), "w2c": w} for d, w in out], render)
    return 0


def cmd_report(ws: Workspace, args) -> int:
    from .report import render_html
    with open(args.out, "w") as fh:
        fh.write(render_html(ws))
    print(f"wrote {args.out}")
    return 0


def cmd_payments(ws: Workspace, args) -> int:
    rows = [r for r in instructions(ws.statuses, ws.companies, ws.group, ws.as_of, args.include_optional)
            if not args.company or r["company_id"] == args.company]
    if args.csv:
        import csv
        with open(args.csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]) if rows else ["status"])
            w.writeheader()
            w.writerows(rows)
        print(f"wrote {len(rows)} payment instructions to {args.csv} ({NOT_TRANSMITTED})")
        return 0
    headers = ["company_id", "payee", "deposit_group", "eftps_tax_type", "tax_period_end", "amount", "initiate_by",
               "due", "past_due", "state_account"]
    _out(args, rows, lambda: (print(NOT_TRANSMITTED), print(table([[r[h] for h in headers] for r in rows], headers))))
    return 0


def cmd_locate(args) -> int:
    """Tax locator: employee addresses -> local-tax certificate fields."""
    raw = json.loads(open(args.employees).read())
    check_date = (args.as_of or date.today()).isoformat()
    requests = []
    for i, e in enumerate(raw["employees"]):
        addr = e.get("address") or {}
        if addr.get("work") or addr.get("residence"):
            requests.append({"key": str(i), "work": addr.get("work"), "residence": addr.get("residence"),
                             "checkDate": check_date})
    if not requests:
        print("no employee has an address.work or address.residence to locate")
        return 1
    results = taxengine.locate(requests)
    unresolved = 0
    for req in requests:
        e, r = raw["employees"][int(req["key"])], results[req["key"]]
        who = f"{e['company_id']}/{e['employee_id']}"
        if "error" in r:
            unresolved += 1
            print(f"{who}: lookup failed — {r['error']}")
            continue
        print(f"{who}: {json.dumps(r['certificateFields'])}" + ("" if r["fullyResolved"] else "  [NEEDS REVIEW]"))
        for reason in r["lowConfidenceReasons"] + r["lookupFailures"] + r["notResolvable"]:
            print(f"    - {reason}")
        unresolved += not r["fullyResolved"]
        if args.write and r["certificateFields"]:
            e["work_state_certificate"] = {**(e.get("work_state_certificate") or {}), **r["certificateFields"]}
    if args.write:
        with open(args.employees, "w") as fh:
            json.dump(raw, fh, indent=2)
            fh.write("\n")
        print(f"updated {args.employees}")
    return 1 if unresolved else 0


def cmd_coverage(args) -> int:
    for year in taxengine.covered_years():
        states = taxengine.covered_states(year)
        fica, futa = taxengine.fica_rates(year), taxengine.futa_rates(year)
        print(f"{year}: federal + {len(states)} jurisdictions ({', '.join(states)})")
        print(f"  local registries: {', '.join(taxengine.local_registries(year))}")
        print(f"  SS wage base {fmt(fica['ss_base'])}, FICA {fica['ss']} + {fica['med']}, "
              f"Additional Medicare {fica['addl']}; FUTA {futa['net']} on {fmt(futa['base'])}, credit reductions: "
              + (", ".join(f"{k} {v}" for k, v in futa["credit_reductions"].items()) or
                 f"pending (determined after {futa['determination_date']})"))
    if args.state:
        for year in taxengine.covered_years():
            s = taxengine.state(args.state.upper(), year)
            if not s:
                continue
            sui = s.get("suiEmployer") or {}
            print(f"\n{s['name']} {year}: method {s.get('method')}; SUI wage base {sui.get('wageBase')}, "
                  f"new-employer rate {sui.get('newEmployerRate')}")
            for src in s.get("sources", [])[:8]:
                print(f"  source: {src.get('title')} — {src.get('url')} (verified {src.get('verifiedOn')})")
            for gap in s.get("knownGaps", []):
                print(f"  known gap: {gap[:200]}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="masterytax", description="Payroll tax liabilities, deposits and filings.")
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp):
        sp.add_argument("--payroll", nargs="+", required=True, help="payroll register CSV file(s)")
        sp.add_argument("--companies", required=True, help="companies JSON")
        sp.add_argument("--deposits", help="deposits made CSV")
        sp.add_argument("--employees", help="employee W-4 / state certificate JSON (enables withholding checks)")
        sp.add_argument("--agencies", help="alternate agency / deposit-schedule routing JSON")
        sp.add_argument("--company", help="limit to one company id")
        sp.add_argument("--as-of", type=date.fromisoformat, help="evaluate lateness as of this date (default today)")
        sp.add_argument("--json", action="store_true", help="machine-readable output")
        return sp

    common(sub.add_parser("validate", help="import exceptions and withholding variances"))
    common(sub.add_parser("liabilities", help="liabilities by tax")).add_argument(
        "--explain", metavar="EMPLOYEE_ID", help="show the calculation trace for one employee")
    common(sub.add_parser("deposits", help="deposit calendar, matching and penalty exposure"))
    for name, needs_q in (("941", True), ("940", False), ("w2", False)):
        sp = common(sub.add_parser(name, help=f"build Form {name.upper()}"))
        sp.add_argument("--year", type=int, required=True)
        if needs_q:
            sp.add_argument("--quarter", type=int, choices=[1, 2, 3, 4], required=True)
    sp = common(sub.add_parser("state", help="state quarterly wage & contribution report"))
    sp.add_argument("--state", required=True)
    sp.add_argument("--year", type=int, required=True)
    sp.add_argument("--quarter", type=int, choices=[1, 2, 3, 4], required=True)
    sp = common(sub.add_parser("amend", help="941-X and W-2c by recomputing from corrected payroll"))
    sp.add_argument("--corrected", nargs="+", required=True, help="corrected payroll CSV(s); --payroll is the original")
    sp.add_argument("--year", type=int, required=True)
    sp.add_argument("--quarter", type=int, choices=[1, 2, 3, 4], required=True)
    common(sub.add_parser("report", help="self-contained HTML compliance dashboard")).add_argument(
        "--out", default="masterytax-report.html")
    sp = common(sub.add_parser("payments", help="payment instructions for open obligations (never transmitted)"))
    sp.add_argument("--csv", help="write instructions to this CSV file")
    sp.add_argument("--include-optional", action="store_true", help="include de minimis obligations")
    sub.add_parser("coverage", help="tax years, jurisdictions and sources the engine covers").add_argument(
        "--state", help="show one state's sources and known gaps")

    sp = sub.add_parser("locate", help="tax locator: employee addresses -> local tax certificate fields (network)")
    sp.add_argument("--employees", required=True, help="employees JSON with address.work / address.residence")
    sp.add_argument("--as-of", type=date.fromisoformat, help="rules date (default today)")
    sp.add_argument("--write", action="store_true", help="merge the fields into work_state_certificate")

    args = p.parse_args(argv)
    if args.command == "coverage":
        return cmd_coverage(args)
    if args.command == "locate":
        return cmd_locate(args)
    ws = Workspace.load(args.payroll, args.companies, args.deposits, args.employees, args.agencies, args.as_of)
    handler = {"validate": cmd_validate, "liabilities": cmd_liabilities, "deposits": cmd_deposits,
               "941": cmd_941, "940": cmd_940, "w2": cmd_w2, "state": cmd_state, "amend": cmd_amend,
               "report": cmd_report, "payments": cmd_payments}[args.command]
    return handler(ws, args)


if __name__ == "__main__":
    sys.exit(main())
