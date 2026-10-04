"""Self-contained HTML compliance dashboard (no external assets, works offline)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from html import escape

from .deposits import federal_schedule
from .money import ZERO, fmt
from .pipeline import Workspace
from .returns import ReturnDoc, w3_reconcile

CSS = """
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e1dc;--card:#fff;--bad:#b42318;--warn:#a15c07;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#9a9993;--line:#2e2d2a;--card:#1e1e1c;--bad:#f97066;--warn:#fdb022;--ok:#47cd89}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:40px 0 8px}
h3{font-size:14px;margin:24px 0 8px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.sub{color:var(--muted);margin:0 0 24px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.kpi b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.kpi span{color:var(--muted);font-size:12px}.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}td.wrap{white-space:normal;min-width:260px}th{color:var(--muted);font-weight:600;font-size:12px}
td.n{text-align:right}.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--ok)}details{margin:8px 0}summary{cursor:pointer;font-weight:600}
.note{color:var(--muted);font-size:12px}
"""

STATUS_CLASS = {"paid": "ok", "late": "warn", "overdue": "bad", "open": "", "optional-unpaid": ""}
SEV_CLASS = {"error": "bad", "warning": "warn", "info": ""}


def _td(v, cls="") -> str:
    if isinstance(v, (Decimal, int)):
        return f'<td class="n {cls}">{fmt(v) if isinstance(v, Decimal) else v}</td>'
    text = str(v)
    return f'<td class="{cls}{" wrap" if len(text) > 60 else ""}">{escape(text)}</td>'


def _table(headers, rows, flag_col=None, classes=None) -> str:
    """flag_col: index of a column whose value is colored via the classes mapping."""
    head = "".join(f"<th>{escape(h)}</th>" for h in headers)
    body = "".join(
        "<tr>" + "".join(_td(c, (classes or {}).get(c, "") if i == flag_col else "") for i, c in enumerate(r))
        + "</tr>" for r in rows)
    return f'<div class="wrap"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def _doc(doc: ReturnDoc) -> str:
    parts = [f"<details><summary>Form {escape(doc.form)} — {escape(doc.period)}</summary>",
             _table(["Line", "Description", "Amount"], [[l.line, l.label, l.value] for l in doc.lines])]
    for name, rows in doc.schedules.items():
        if rows:
            headers = list(rows[0].keys())
            parts += [f"<h3>{escape(name)}</h3>", _table(headers, [[r[h] for h in headers] for r in rows])]
    parts += [f'<p class="note">{escape(n)}</p>' for n in doc.notes]
    parts.append("</details>")
    return "".join(parts)


def render_html(ws: Workspace) -> str:
    out = [f"<!doctype html><html lang=en><head><meta charset=utf-8>"
           f"<meta name=viewport content='width=device-width,initial-scale=1'>"
           f"<title>MasteryTax Report</title><style>{CSS}</style></head><body><main>",
           "<h1>Payroll tax compliance report</h1>",
           f'<p class="sub">As of {ws.as_of} · {len(ws.lines)} payroll rows · {len(ws.companies)} companies</p>']

    for cid, company in sorted(ws.companies.items()):
        liabs = [l for l in ws.liabilities if l.company_id == cid]
        if not liabs:
            continue
        sts = [s for s in ws.statuses if s.obligation.company_id == cid]
        issues = [i for i in ws.issues if i.company_id == cid]
        total = sum((l.amount for l in liabs), ZERO)
        past_due = sum((s.outstanding for s in sts if not s.obligation.optional and s.obligation.due < ws.as_of),
                       ZERO)
        penalty = sum((s.penalty or ZERO for s in sts), ZERO)
        next_due = min((s.obligation.due for s in sts if s.outstanding > 0 and s.obligation.due >= ws.as_of),
                       default=None)
        errors = sum(1 for i in issues if i.severity == "error")

        out.append(f"<h2>{escape(company.name)} <span class=note>{escape(cid)} · FEIN {escape(company.fein)} · "
                   f"federal {federal_schedule(company)} depositor</span></h2>")
        out.append('<div class="kpis">' + "".join(
            f'<div class="kpi"><span>{label}</span><b class="{cls}">{val}</b></div>' for label, val, cls in [
                ("Total liability", fmt(total), ""),
                ("Past-due deposits", fmt(past_due), "bad" if past_due else "ok"),
                ("Est. FTD penalty exposure", fmt(penalty), "bad" if penalty else "ok"),
                ("Next deposit due", next_due.isoformat() if next_due else "—", ""),
                ("Open errors", str(errors), "bad" if errors else "ok"),
            ]) + "</div>")

        out.append("<h3>Deposit calendar</h3>")
        out.append(_table(
            ["Group", "Period", "Due", "Amount", "Paid", "Outstanding", "Status", "Days late", "Est. penalty"],
            [[s.obligation.group, s.obligation.period, s.obligation.due.isoformat(), s.obligation.amount, s.paid,
              s.outstanding, s.status, s.days_late or "", s.penalty if s.penalty else ""] for s in sts],
            flag_col=6, classes=STATUS_CLASS))

        if issues:
            out.append("<h3>Exceptions</h3>")
            out.append(_table(["Severity", "Code", "Employee", "Row", "Message"],
                              [[i.severity, i.code, i.employee_id, i.row or "", i.message] for i in issues],
                              flag_col=0, classes=SEV_CLASS))

        out.append("<h3>Returns</h3>")
        for year, quarter in ws.periods(cid):
            out.append(_doc(ws.form_941(cid, year, quarter)))
        for year in sorted({y for y, _ in ws.periods(cid)}):
            out.append(_doc(ws.form_940(cid, year)))
            w3, recon = w3_reconcile(company, ws.liabilities, ws.rules, year)
            status = "balanced" if not recon else "; ".join(i.message for i in recon)
            out.append(f'<p class="note">W-2/W-3 vs 941 reconciliation {year}: {escape(status)}</p>')

    unassigned = [i for i in ws.issues if not i.company_id]
    if unassigned:
        out.append("<h2>File-level exceptions</h2>")
        out.append(_table(["Severity", "Code", "Source", "Row", "Message"],
                          [[i.severity, i.code, i.source, i.row or "", i.message] for i in unassigned]))
    out.append(f'<p class="note" style="margin-top:40px">{escape(ws.rules.disclaimer)} Generated {date.today()}.</p>')
    out.append("</main></body></html>")
    return "".join(out)
