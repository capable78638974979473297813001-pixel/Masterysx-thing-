"""Command line: `python -m masterytax <command> ...` (see README)."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from decimal import Decimal

from .deposits import federal_schedule
from .engine import compute_liabilities
from .importer import load_payroll
from .money import fmt
from .pipeline import Workspace
from .returns import (ReturnDoc, _jsonable, amend_941, state_wage_report, w2_records, w2c_records,
                      w3_reconcile)
from .rules import RuleBook


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
    rows = [[c, g, t, ws.rules.taxes[t].payer, amt] for (c, g, t), amt in sorted(summary.items())
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
    recon = {cid: w3_reconcile(ws.companies[cid], ws.liabilities, ws.rules, args.year) for cid in _companies(ws, args)}

    def render():
        boxes = ["box1", "box2", "box3", "box4", "box5", "box6", "box12_D", "box14_CASDI"]
        print(table([[r["company_id"], r["employee_id"], r["name"]] + [r[b] for b in boxes] for r in recs],
                    ["Company", "Employee", "Name"] + boxes))
        for cid, (w3, issues) in recon.items():
            print(f"\nW-3 {cid}: " + ", ".join(f"{k}={_cell(v)}" for k, v in w3.items()))
            print("W-2/941 reconciliation: " + ("balanced" if not issues else ""))
            for i in issues:
                print(f"  {i.severity}: {i.message}")
    _out(args, {"w2": recs, "w3": {c: r[0] for c, r in recon.items()},
                "reconciliation": {c: [i.as_dict() for i in r[1]] for c, r in recon.items()}}, render)
    return 1 if any(r[1] for r in recon.values()) else 0


def cmd_state(ws: Workspace, args) -> int:
    docs = [state_wage_report(ws.companies[cid], ws.liabilities, ws.rules, args.state.upper(), args.year, args.quarter)
            for cid in _companies(ws, args)]
    _out(args, [d.as_dict() for d in docs], lambda: [print_doc(d) for d in docs])
    return 0


def cmd_amend(ws: Workspace, args) -> int:
    corrected_lines, issues = load_payroll(args.corrected, ws.companies, ws.rules.supported_states())
    corrected = compute_liabilities(corrected_lines, ws.companies, ws.rules)
    out = []
    for cid in _companies(ws, args):
        doc = amend_941(ws.companies[cid], ws.liabilities, corrected, ws.rules, args.year, args.quarter)
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


def cmd_rules(args) -> int:
    rules = RuleBook.load(args.rules)
    rows = []
    for t in rules.taxes.values():
        for v in t.versions:
            rows.append([t.code, t.jurisdiction, t.payer, t.deposit_group, v.effective,
                         str(v.rate) if v.rate is not None else ("company" if t.rate_source == "company" else "reported"),
                         v.wage_base if v.wage_base is not None else (v.threshold or ""), v.source])
    print(table(rows, ["Tax", "Juris.", "Payer", "Group", "Effective", "Rate", "Base/threshold", "Source"]))
    print(f"\n{rules.disclaimer}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="masterytax", description="Payroll tax liabilities, deposits and filings.")
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp):
        sp.add_argument("--payroll", nargs="+", required=True, help="payroll register CSV file(s)")
        sp.add_argument("--companies", required=True, help="companies JSON")
        sp.add_argument("--deposits", help="deposits made CSV")
        sp.add_argument("--rules", help="alternate rules JSON")
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
    sub.add_parser("rules", help="list tax rules and sources").add_argument("--rules")

    args = p.parse_args(argv)
    if args.command == "rules":
        return cmd_rules(args)
    ws = Workspace.load(args.payroll, args.companies, args.deposits, args.rules, args.as_of)
    handler = {"validate": cmd_validate, "liabilities": cmd_liabilities, "deposits": cmd_deposits,
               "941": cmd_941, "940": cmd_940, "w2": cmd_w2, "state": cmd_state, "amend": cmd_amend,
               "report": cmd_report}[args.command]
    return handler(ws, args)


if __name__ == "__main__":
    sys.exit(main())
