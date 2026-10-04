"""Generate the Q1 2026 sample data set in this folder.

Two employers, deliberately seeded with the problems MasteryTax should catch:
  * an invalid SSN (row is held, not silently processed)
  * an executive whose payroll system forgot Additional Medicare withholding
  * a NY employer with no SUI rate on file (default-rate warning)
  * one federal deposit made 3 days late and one never made
A corrected register (a missed $1,000 bonus) drives the 941-X / W-2c demo.

Run:  python examples/generate_sample.py
"""

from __future__ import annotations

import csv
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from masterytax.money import r2  # noqa: E402

SS_BASE = Decimal("184500")
COLUMNS = ["company_id", "employee_id", "ssn", "first_name", "last_name", "pay_date", "period_start", "period_end",
           "work_state", "gross_wages", "pretax_401k", "pretax_s125", "fit_withheld", "ss_withheld",
           "medicare_withheld", "sit_withheld", "sdi_withheld"]

# id, first, last, ssn, annual salary, 401k %, s125 per check, state
ACME = [
    ("A100", "Maria", "Lopez", "512-34-1001", "1200000", "0.05", "250", "CA"),
    ("A101", "James", "Chen", "512-34-1002", "145000", "0.06", "180", "CA"),
    ("A102", "Aisha", "Patel", "512-34-1003", "98000", "0.04", "120", "CA"),
    ("A103", "Tom", "Becker", "512-34-1004", "72000", "0", "120", "CA"),
    ("A104", "Grace", "Kim", "512-34-1005", "64000", "0.03", "0", "CA"),
    ("A105", "Leo", "Nguyen", "123-00-4567", "58000", "0", "0", "CA"),  # invalid SSN (group 00)
]
NORTHWIND = [
    ("N200", "Sam", "Rivera", "414-22-2001", "88000", "0.05", "90", "NY"),
    ("N201", "Priya", "Shah", "414-22-2002", "76000", "0", "90", "NY"),
    ("N202", "Dana", "Brooks", "414-22-2003", "61000", "0.04", "0", "TX"),
]
SIT_RATE = {"CA": Decimal("0.055"), "NY": Decimal("0.05"), "TX": Decimal("0")}


def biweekly(first: date, last: date):
    d = first
    while d <= last:
        yield d - timedelta(days=13), d - timedelta(days=0), d
        d += timedelta(days=14)


def semimonthly(year: int, months):
    import calendar
    for m in months:
        for start, end in ((1, 15), (16, calendar.monthrange(year, m)[1])):
            pay = date(year, m, end)
            while pay.weekday() >= 5:
                pay -= timedelta(days=1)
            yield date(year, m, start), date(year, m, end), pay


def rows_for(company, employees, schedule, periods_per_year, bonus=None):
    ytd = {}
    out = []
    for start, end, pay in schedule:
        for emp_id, first, last, ssn, salary, k401_pct, s125, state in employees:
            gross = r2(Decimal(salary) / periods_per_year)
            if bonus and bonus == (emp_id, pay):
                gross += Decimal("1000")
            k401 = r2(gross * Decimal(k401_pct))
            s125 = Decimal(s125)
            fica_wages = gross - s125
            prior = ytd.get(emp_id, Decimal(0))
            ytd[emp_id] = prior + fica_wages
            ss_taxable = max(Decimal(0), min(fica_wages, SS_BASE - prior))
            ss = r2(ss_taxable * Decimal("0.062"))
            med = r2(fica_wages * Decimal("0.0145"))  # Additional Medicare deliberately forgotten
            fit_wages = gross - k401 - s125
            out.append({
                "company_id": company, "employee_id": emp_id, "ssn": ssn, "first_name": first, "last_name": last,
                "pay_date": pay.isoformat(), "period_start": start.isoformat(), "period_end": end.isoformat(),
                "work_state": state, "gross_wages": gross, "pretax_401k": k401, "pretax_s125": s125,
                "fit_withheld": r2(fit_wages * Decimal("0.14")), "ss_withheld": ss, "medicare_withheld": med,
                "sit_withheld": r2(fit_wages * SIT_RATE[state]),
                "sdi_withheld": r2(fica_wages * Decimal("0.013")) if state == "CA" else "",
            })
    return out


def write(path: Path, rows):
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)


def build(bonus=None):
    acme = rows_for("ACME", ACME, biweekly(date(2026, 1, 9), date(2026, 3, 31)), 26, bonus)
    nw = rows_for("NORTHWIND", NORTHWIND, semimonthly(2026, (1, 2, 3)), 24)
    return acme + nw


def main():
    write(HERE / "payroll_2026q1.csv", build())
    write(HERE / "payroll_2026q1_corrected.csv", build(bonus=("A103", date(2026, 2, 20))))

    # Deposits: pay every obligation on time, except one 3 days late and one never made.
    from masterytax.pipeline import Workspace
    ws = Workspace.load(HERE / "payroll_2026q1.csv", HERE / "companies.json", as_of=date(2026, 4, 15))
    deposits = []
    acme_941 = [o for o in ws.obligations if o.company_id == "ACME" and o.group == "US-941"]
    late, missed = acme_941[2], acme_941[-1]
    for i, o in enumerate(ws.obligations):
        if o is missed or o.due > date(2026, 4, 15):
            continue
        paid_on = o.due + timedelta(days=3) if o is late else o.due
        deposits.append({"company_id": o.company_id, "deposit_group": o.group, "date": paid_on.isoformat(),
                         "amount": o.amount, "reference": f"EFT{1000 + i}"})
    with open(HERE / "deposits.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["company_id", "deposit_group", "date", "amount", "reference"])
        w.writeheader()
        w.writerows(deposits)
    print(f"wrote payroll ({len(build())} rows), corrected payroll, and {len(deposits)} deposits")


if __name__ == "__main__":
    main()
