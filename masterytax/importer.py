"""Payroll register import with an auditable exception report.

Rows with errors are held out of processing (and listed) instead of failing the
whole import, so one bad record never blocks a filing.
"""

from __future__ import annotations

import csv
import re
from datetime import date
from pathlib import Path

from .models import DEDUCTION_COLUMNS, REPORTED_COLUMNS, Company, Issue, PayLine
from .money import ZERO, D

REQUIRED = ("company_id", "employee_id", "ssn", "first_name", "last_name", "pay_date", "work_state", "gross_wages")
SSN_RE = re.compile(r"^\d{3}-?\d{2}-?\d{4}$")


def _valid_ssn(raw: str) -> bool:
    if not SSN_RE.match(raw):
        return False
    digits = raw.replace("-", "")
    area, group, serial = digits[:3], digits[3:5], digits[5:]
    return area not in ("000", "666") and not area.startswith("9") and group != "00" and serial != "0000"


def load_payroll(
    paths, companies: dict[str, Company], supported_states: set[str]
) -> tuple[list[PayLine], list[Issue]]:
    lines: list[PayLine] = []
    issues: list[Issue] = []
    seen: dict[tuple, int] = {}
    for path in [paths] if isinstance(paths, (str, Path)) else paths:
        source = Path(path).name
        with open(path, newline="") as fh:
            reader = csv.DictReader(fh)
            missing = [c for c in REQUIRED if c not in (reader.fieldnames or [])]
            if missing:
                issues.append(Issue("error", "missing-columns", f"missing required columns: {', '.join(missing)}", source=source))
                continue
            for rownum, raw in enumerate(reader, start=2):
                line, row_issues = _parse_row(raw, rownum, source, companies, supported_states)
                issues.extend(row_issues)
                if line is None:
                    continue
                key = (line.company_id, line.employee_id, line.pay_date, line.gross)
                if key in seen:
                    issues.append(
                        Issue("warning", "possible-duplicate",
                              f"same employee, pay date and gross as row {seen[key]}",
                              line.company_id, line.employee_id, rownum, source)
                    )
                seen[key] = rownum
                lines.append(line)
    return lines, issues


def _parse_row(raw, rownum, source, companies, supported_states):
    issues = []

    def err(code, msg, severity="error"):
        issues.append(Issue(severity, code, msg, raw.get("company_id", ""), raw.get("employee_id", ""), rownum, source))

    row = {k: (v or "").strip() for k, v in raw.items() if k is not None}
    for col in REQUIRED:
        if not row.get(col):
            err("missing-value", f"{col} is blank")
    if issues:
        return None, issues

    if row["company_id"] not in companies:
        err("unknown-company", f"company {row['company_id']} is not set up")
    if not _valid_ssn(row["ssn"]):
        err("invalid-ssn", "SSN is not a valid, issuable number")
    state = row["work_state"].upper()
    if state not in supported_states:
        err("unsupported-state", f"no state rules for {state}; only federal taxes will be computed", "warning")

    dates = {}
    for col in ("pay_date", "period_start", "period_end"):
        if row.get(col):
            try:
                dates[col] = date.fromisoformat(row[col])
            except ValueError:
                err("bad-date", f"{col} {row[col]!r} is not YYYY-MM-DD")

    money = {}
    for col in ("gross_wages", *DEDUCTION_COLUMNS, *REPORTED_COLUMNS):
        if row.get(col):
            try:
                money[col] = D(row[col])
            except ValueError:
                err("bad-amount", f"{col} {row[col]!r} is not a number")
    if any(i.severity == "error" for i in issues):
        return None, issues

    gross = money["gross_wages"]
    deductions = {DEDUCTION_COLUMNS[c]: money.get(c, ZERO) for c in DEDUCTION_COLUMNS}
    if gross < 0:
        err("negative-wages", "negative gross treated as a correction/reversal", "warning")
    if gross >= 0 and sum(deductions.values()) > gross:
        err("deductions-exceed-gross", "pre-tax deductions exceed gross wages")
        return None, issues
    for col in REPORTED_COLUMNS:
        if money.get(col, ZERO) < 0 and gross >= 0:
            err("negative-withholding", f"{col} is negative on a positive paycheck", "warning")

    return (
        PayLine(
            row=rownum,
            source=source,
            company_id=row["company_id"],
            employee_id=row["employee_id"],
            ssn=row["ssn"].replace("-", ""),
            first_name=row["first_name"],
            last_name=row["last_name"],
            pay_date=dates["pay_date"],
            work_state=state,
            gross=gross,
            deductions=deductions,
            reported={c: money[c] for c in REPORTED_COLUMNS if c in money},
            period_start=dates.get("period_start"),
            period_end=dates.get("period_end"),
        ),
        issues,
    )


def load_deposits(path) -> tuple[list[dict], list[Issue]]:
    """Deposits already made: company_id, deposit_group, date, amount[, reference]."""
    out, issues = [], []
    with open(path, newline="") as fh:
        for rownum, row in enumerate(csv.DictReader(fh), start=2):
            try:
                out.append(
                    {
                        "company_id": row["company_id"].strip(),
                        "deposit_group": row["deposit_group"].strip(),
                        "date": date.fromisoformat(row["date"].strip()),
                        "amount": D(row["amount"]),
                        "reference": (row.get("reference") or "").strip(),
                    }
                )
            except (KeyError, ValueError) as exc:
                issues.append(Issue("error", "bad-deposit", f"deposit row unreadable: {exc}", row=rownum, source=Path(path).name))
    return out, issues
