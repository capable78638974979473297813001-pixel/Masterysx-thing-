"""Generate the Q1 2026 sample data set in this folder.

The "payroll system" here is the tax engine itself (so withholding is right),
with the mistakes MasteryTax must catch deliberately injected:
  * an invalid SSN (the rows are held, not silently processed)
  * an executive whose payroll forgot Additional Medicare and didn't stop
    Social Security at the wage base
  * an employee whose W-4 extra withholding ($50/check) payroll ignored
  * a Pittsburgh employee whose $52 LST was never withheld
  * a NY employer with no SUI rate on file (default-rate warning)
  * one federal deposit 3 days late, one never made, one NY deposit late
A corrected register (a missed $1,000 bonus) drives the 941-X / W-2c demo.

Run:  python examples/generate_sample.py
"""

from __future__ import annotations

import calendar
import csv
import json
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from masterytax import taxengine  # noqa: E402
from masterytax.engine import _paycheck_input, dollars  # noqa: E402
from masterytax.models import PayLine, load_companies, load_employees  # noqa: E402
from masterytax.money import r2  # noqa: E402

COLUMNS = ["company_id", "employee_id", "ssn", "first_name", "last_name", "pay_date", "period_start", "period_end",
           "pay_frequency", "work_state", "gross_wages", "supplemental_wages", "pretax_401k", "pretax_s125",
           "fit_withheld", "ss_withheld", "medicare_withheld", "sit_withheld", "sdi_withheld", "local_withheld"]

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
KEYSTONE = [
    ("K300", "Ellen", "Walsh", "201-55-3001", "70000", "0.05", "60", "PA"),
    ("K301", "Marcus", "Reed", "201-55-3002", "52000", "0", "60", "PA"),
    ("K302", "Nina", "Ortiz", "268-44-3003", "66000", "0.03", "0", "OH"),
]


def biweekly(first: date, last: date):
    d = first
    while d <= last:
        yield d - timedelta(days=13), d, d
        d += timedelta(days=14)


def weekly(first: date, last: date):
    d = first
    while d <= last:
        yield d - timedelta(days=6), d, d
        d += timedelta(days=7)


def semimonthly(year: int, months):
    for m in months:
        for start, end in ((1, 15), (16, calendar.monthrange(year, m)[1])):
            pay = date(year, m, end)
            while pay.weekday() >= 5:
                pay -= timedelta(days=1)
            yield date(year, m, start), date(year, m, end), pay


def rows_for(company, employees, schedule, freq, periods, companies, profiles, bonus=None):
    rows, lines = [], []
    for start, end, pay in schedule:
        for emp_id, first, last, ssn, salary, k401_pct, s125, state in employees:
            gross = r2(Decimal(salary) / periods)
            supplemental = Decimal(0)
            if bonus and bonus == (emp_id, pay):
                gross += Decimal("1000")
                supplemental = Decimal("1000")
            k401 = r2(gross * Decimal(k401_pct))
            line = PayLine(len(lines), "gen", company, emp_id, ssn.replace("-", ""), first, last, pay, state, gross,
                           {"deferral_401k": k401, "section125": Decimal(s125)}, {}, start, end, freq, supplemental)
            lines.append(line)
            rows.append({"company_id": company, "employee_id": emp_id, "ssn": ssn, "first_name": first,
                         "last_name": last, "pay_date": pay.isoformat(), "period_start": start.isoformat(),
                         "period_end": end.isoformat(), "pay_frequency": freq, "work_state": state,
                         "gross_wages": gross, "supplemental_wages": supplemental or "", "pretax_401k": k401,
                         "pretax_s125": s125})
    batch = [{"key": str(i), "companyId": l.company_id, "employeeId": l.employee_id, "seq": i,
              "input": _paycheck_input(l, companies[l.company_id], profiles.get((l.company_id, l.employee_id)),
                                       l.pay_frequency)} for i, l in enumerate(lines)]
    results = taxengine.run_paychecks(batch)
    for i, row in enumerate(rows):
        taxes = {t["id"]: t for t in results[str(i)]["taxes"]}
        amt = lambda pred: sum((dollars(t["amount"]) for tid, t in taxes.items() if pred(tid, t)), Decimal(0))  # noqa: E731
        row["fit_withheld"] = amt(lambda k, t: k.startswith("US_FIT"))
        row["ss_withheld"] = amt(lambda k, t: k == "US_SS_EE")
        row["medicare_withheld"] = amt(lambda k, t: k in ("US_MED_EE", "US_MED_ADDL"))
        row["sit_withheld"] = amt(lambda k, t: k[2:7] == "_SIT" and k[:2].isalpha())
        sdi = amt(lambda k, t: k[2:] in ("_DBL_EE", "_PFML_EE", "_UC_EE", "_LTC_EE"))
        row["sdi_withheld"] = sdi if sdi else ""
        local = amt(lambda k, t: t["payer"] == "employee" and (t["jurisdiction"] == "local" or "_NYC_" in k))
        row["local_withheld"] = local if local else ""
        inject(row, taxes)
    return rows


SS_CAP_HIT = set()


def inject(row, taxes):
    emp = row["employee_id"]
    if emp == "A100":
        # Payroll forgot Additional Medicare, and kept withholding full 6.2% SS past the wage base.
        row["medicare_withheld"] = dollars(taxes["US_MED_EE"]["amount"])
        full_ss = r2((Decimal(str(row["gross_wages"])) - Decimal(row["pretax_s125"])) * Decimal("0.062"))
        if taxes["US_SS_EE"]["amount"] < full_ss * 100 and emp not in SS_CAP_HIT:
            SS_CAP_HIT.add(emp)
            row["ss_withheld"] = full_ss
    if emp == "A102":
        row["fit_withheld"] -= Decimal("50.00")  # W-4 step 4(c) extra withholding ignored
    if emp == "K301" and "PA_LST" in taxes:
        row["local_withheld"] = Decimal(str(row["local_withheld"] or 0)) - dollars(taxes["PA_LST"]["amount"])


def write(path: Path, rows):
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)


def build(bonus=None):
    companies = load_companies(HERE / "companies.json")
    profiles = load_employees(HERE / "employees.json")
    SS_CAP_HIT.clear()
    acme = rows_for("ACME", ACME, biweekly(date(2026, 1, 9), date(2026, 3, 31)), "biweekly", 26, companies,
                    profiles, bonus)
    nw = rows_for("NORTHWIND", NORTHWIND, semimonthly(2026, (1, 2, 3)), "semimonthly", 24, companies, profiles)
    ks = rows_for("KEYSTONE", KEYSTONE, weekly(date(2026, 1, 2), date(2026, 3, 31)), "weekly", 52, companies,
                  profiles)
    return acme + nw + ks


def main():
    write(HERE / "payroll_2026q1.csv", build())
    write(HERE / "payroll_2026q1_corrected.csv", build(bonus=("A103", date(2026, 2, 20))))

    from masterytax.pipeline import Workspace
    ws = Workspace.load(HERE / "payroll_2026q1.csv", HERE / "companies.json", employees_path=HERE / "employees.json",
                        as_of=date(2026, 4, 15))
    deposits = []
    acme_941 = [o for o in ws.obligations if o.company_id == "ACME" and o.group == "US-941"]
    late, missed = acme_941[2], acme_941[-1]
    ny_late = next(o for o in ws.obligations if o.group == "NY-WH")
    for i, o in enumerate(ws.obligations):
        if o is missed or o.due > date(2026, 4, 15) or o.optional:
            continue
        paid_on = o.due + timedelta(days=3) if o in (late, ny_late) else o.due
        deposits.append({"company_id": o.company_id, "deposit_group": o.group, "date": paid_on.isoformat(),
                         "amount": o.amount, "reference": f"EFT{1000 + i}"})
    with open(HERE / "deposits.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["company_id", "deposit_group", "date", "amount", "reference"])
        w.writeheader()
        w.writerows(deposits)
    print(f"wrote payroll ({len(build())} rows), corrected payroll, and {len(deposits)} deposits")


if __name__ == "__main__":
    main()
