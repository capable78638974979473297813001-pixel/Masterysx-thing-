"""Return builders: Form 941 (+ Schedule B), Form 940 (+ Schedule A), W-2/W-3,
state quarterly wage reports, and amendments (941-X / W-2c) by recomputation.

Each return is plain data (lines with labels) so it can be rendered, diffed,
exported or mapped to an e-file format without re-deriving numbers.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from .bizcal import quarter_bounds
from .deposits import Obligation, federal_schedule, futa_credit_reduction
from .engine import period_total
from .models import Company, Issue, Liability
from .money import ZERO, fmt, r2
from .rules import RuleBook

FICA_CODES = ("FED_SS_EE", "FED_SS_ER", "FED_MED_EE", "FED_MED_ER", "FED_ADDL_MED")
DE_MINIMIS_941 = Decimal("2500")


@dataclass
class ReturnLine:
    line: str
    label: str
    value: object


@dataclass
class ReturnDoc:
    form: str
    company_id: str
    company_name: str
    fein: str
    period: str
    lines: list[ReturnLine] = field(default_factory=list)
    schedules: dict = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def add(self, line: str, label: str, value) -> object:
        self.lines.append(ReturnLine(line, label, value))
        return value

    def value(self, line: str):
        for l in self.lines:
            if l.line == line:
                return l.value
        raise KeyError(line)

    def as_dict(self) -> dict:
        return {
            "form": self.form, "company_id": self.company_id, "company_name": self.company_name,
            "fein": self.fein, "period": self.period,
            "lines": [{"line": l.line, "label": l.label, "value": str(l.value)} for l in self.lines],
            "schedules": _jsonable(self.schedules), "notes": self.notes,
        }


def _jsonable(obj):
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (Decimal, date)):
        return str(obj)
    return obj


def _sum(liabs, code, attr="amount") -> Decimal:
    return sum((getattr(l, attr) for l in liabs if l.tax_code == code), ZERO)


# ------------------------------------------------------------------ 941 ---

def form_941(company: Company, liabilities: list[Liability], rules: RuleBook, year: int, quarter: int,
             deposits: Decimal = ZERO, obligations: list[Obligation] | None = None) -> ReturnDoc:
    start, end = quarter_bounds(year, quarter)
    q = [l for l in liabilities if l.company_id == company.id and start <= l.pay_date <= end]
    doc = ReturnDoc("941", company.id, company.name, company.fein, f"{year} Q{quarter}")

    twelfth = date(year, quarter * 3, 12)
    employees, used_month_fallback = set(), False
    for l in q:
        if l.tax_code != "FED_FIT":
            continue
        line = l.line
        if line.period_start and line.period_end:
            if line.period_start <= twelfth <= line.period_end:
                employees.add(line.employee_id)
        elif line.pay_date.month == quarter * 3:
            employees.add(line.employee_id)
            used_month_fallback = True
    if used_month_fallback:
        doc.notes.append("Line 1: some rows lacked pay-period dates; counted employees paid in the quarter's last month.")

    ss = rules.taxes["FED_SS_EE"].version_for(end).rate + rules.taxes["FED_SS_ER"].version_for(end).rate
    med = rules.taxes["FED_MED_EE"].version_for(end).rate + rules.taxes["FED_MED_ER"].version_for(end).rate
    addl = rules.taxes["FED_ADDL_MED"].version_for(end).rate

    doc.add("1", f"Employees paid for the pay period including {twelfth:%b %d}", len(employees))
    doc.add("2", "Wages, tips, and other compensation", _sum(q, "FED_FIT", "subject_wages"))
    l3 = doc.add("3", "Federal income tax withheld", _sum(q, "FED_FIT"))
    ss_w = doc.add("5a.1", "Taxable social security wages", _sum(q, "FED_SS_EE", "taxable_wages"))
    ss_t = doc.add("5a.2", f"Social security tax (x {ss})", r2(ss_w * ss))
    med_w = doc.add("5c.1", "Taxable Medicare wages & tips", _sum(q, "FED_MED_EE", "taxable_wages"))
    med_t = doc.add("5c.2", f"Medicare tax (x {med})", r2(med_w * med))
    addl_w = doc.add("5d.1", "Wages subject to Additional Medicare withholding", _sum(q, "FED_ADDL_MED", "taxable_wages"))
    addl_t = doc.add("5d.2", f"Additional Medicare tax (x {addl})", r2(addl_w * addl))
    l5e = doc.add("5e", "Total social security and Medicare taxes", ss_t + med_t + addl_t)
    l6 = doc.add("6", "Total taxes before adjustments", l3 + l5e)
    actual_fica = sum((_sum(q, c) for c in FICA_CODES), ZERO)
    l7 = doc.add("7", "Current quarter's adjustment for fractions of cents", actual_fica - l5e)
    l10 = doc.add("10", "Total taxes after adjustments", l6 + l7)
    l12 = doc.add("12", "Total taxes after adjustments and nonrefundable credits", l10)
    l13 = doc.add("13", "Total deposits for this quarter", deposits)
    doc.add("14", "Balance due", max(l12 - l13, ZERO))
    doc.add("15", "Overpayment", max(l13 - l12, ZERO))

    daily: dict[date, Decimal] = defaultdict(lambda: ZERO)
    for l in q:
        if l.deposit_group == "US-941":
            daily[l.pay_date] += l.amount
    semiweekly = federal_schedule(company) == "semiweekly" or any(
        o.company_id == company.id and o.group == "US-941" and "next-day" in o.period
        and o.year == year and o.quarter <= quarter
        for o in obligations or [])
    if l12 < DE_MINIMIS_941 and not semiweekly:
        doc.notes.append("Line 12 is under $2,500: line 16 may be left as 'less than $2,500'.")
    if semiweekly:
        doc.schedules["Schedule B (daily tax liability)"] = [
            {"date": d, "liability": a} for d, a in sorted(daily.items())]
        doc.add("16", "Semiweekly depositor — see Schedule B", sum(daily.values(), ZERO))
    else:
        months = defaultdict(lambda: ZERO)
        for d, a in daily.items():
            months[d.month] += a
        for i, m in enumerate(range(quarter * 3 - 2, quarter * 3 + 1), start=1):
            doc.add(f"16.m{i}", f"Month {i} liability ({date(year, m, 1):%B})", months[m])
        doc.add("16.total", "Total liability for quarter (must equal line 12)", sum(months.values(), ZERO))
    if sum(daily.values(), ZERO) != l12:
        doc.notes.append("WARNING: liability schedule does not equal line 12.")
    return doc



# ------------------------------------------------------------------ 940 ---

def form_940(company: Company, liabilities: list[Liability], rules: RuleBook, year: int,
             deposits: Decimal = ZERO) -> ReturnDoc:
    y = [l for l in liabilities if l.company_id == company.id and l.pay_date.year == year and l.tax_code == "FED_FUTA"]
    doc = ReturnDoc("940", company.id, company.name, company.fein, str(year))
    rate = rules.taxes["FED_FUTA"].version_for(date(year, 12, 31)).rate
    states = sorted({l.line.work_state for l in y})
    if len(states) == 1:
        doc.add("1a", "State where you paid state unemployment tax", states[0])
    else:
        doc.add("1b", "Multi-state employer (see Schedule A)", ", ".join(states))
    total = doc.add("3", "Total payments to all employees", sum((l.line.gross for l in y), ZERO))
    exempt = doc.add("4", "Payments exempt from FUTA tax", sum((l.line.gross - l.subject_wages for l in y), ZERO))
    over = doc.add("5", "Total of payments made to each employee in excess of $7,000",
                   sum((l.subject_wages - l.taxable_wages for l in y), ZERO))
    l6 = doc.add("6", "Subtotal (line 4 + line 5)", exempt + over)
    l7 = doc.add("7", "Total taxable FUTA wages", total - l6)
    l8 = doc.add("8", f"FUTA tax before adjustments (x {rate})", r2(l7 * rate))
    cr, cr_detail = futa_credit_reduction(y, rules, year)
    l11 = doc.add("11", "Credit reduction (Schedule A)", cr)
    l12 = doc.add("12", "Total FUTA tax after adjustments", l8 + l11)
    l13 = doc.add("13", "FUTA tax deposited for the year", deposits)
    doc.add("14", "Balance due", max(l12 - l13, ZERO))
    doc.add("15", "Overpayment", max(l13 - l12, ZERO))

    by_q = defaultdict(lambda: ZERO)
    for l in y:
        by_q[l.line.quarter] += l.taxable_wages
    q_liab = {q: r2(by_q[q] * rate) for q in (1, 2, 3)}
    q_liab[4] = l12 - sum(q_liab.values(), ZERO)  # Q4 absorbs credit reduction and rounding
    for q in (1, 2, 3, 4):
        doc.add(f"16{'abcd'[q - 1]}", f"Q{q} liability", q_liab[q])
    doc.add("17", "Total tax liability for the year (must equal line 12)", sum(q_liab.values(), ZERO))
    if l12 <= 500:
        doc.notes.append("Line 12 is $500 or less: Part 5 is not required.")

    wages_by_state = defaultdict(lambda: ZERO)
    for l in y:
        wages_by_state[l.line.work_state] += l.taxable_wages
    doc.schedules["Schedule A (multi-state / credit reduction)"] = [
        {"state": st, "futa_taxable_wages": w, "credit_reduction_rate": rules.futa_credit_reduction(year, st),
         "credit_reduction": cr_detail.get(st, ZERO)} for st, w in sorted(wages_by_state.items())]
    if year not in rules.taxes["FED_FUTA"].credit_reductions:
        doc.notes.append(f"Credit reduction states for {year} are not in the rule file yet (announced each November).")
    return doc


# ------------------------------------------------------------- W-2 / W-3 ---

def w2_records(liabilities: list[Liability], year: int, company_id: str | None = None) -> list[dict]:
    per: dict[tuple, dict] = {}
    by_line: dict[int, list[Liability]] = defaultdict(list)
    for l in liabilities:
        if l.pay_date.year == year and (company_id is None or l.company_id == company_id):
            by_line[id(l.line)].append(l)

    for group in by_line.values():
        line = group[0].line
        rec = per.setdefault((line.company_id, line.employee_id), {
            "company_id": line.company_id, "employee_id": line.employee_id, "ssn": line.ssn, "name": line.name,
            "box1": ZERO, "box2": ZERO, "box3": ZERO, "box4": ZERO, "box5": ZERO, "box6": ZERO,
            "box12_D": ZERO, "box14_CASDI": ZERO, "states": {}})
        codes = {l.tax_code: l for l in group}
        rec["box1"] += codes["FED_FIT"].subject_wages
        rec["box2"] += codes["FED_FIT"].amount
        rec["box3"] += codes["FED_SS_EE"].taxable_wages
        rec["box4"] += line.reported.get("ss_withheld", codes["FED_SS_EE"].amount)
        rec["box5"] += codes["FED_MED_EE"].taxable_wages
        rec["box6"] += line.reported.get("medicare_withheld", codes["FED_MED_EE"].amount + codes["FED_ADDL_MED"].amount)
        rec["box12_D"] += line.deductions.get("k401", ZERO)
        if "CA_SDI" in codes:
            rec["box14_CASDI"] += line.reported.get("sdi_withheld", codes["CA_SDI"].amount)
        sit = codes.get(f"{line.work_state}_SIT")
        if sit:
            st = rec["states"].setdefault(line.work_state, {"box16": ZERO, "box17": ZERO})
            st["box16"] += sit.subject_wages
            st["box17"] += sit.amount
    return sorted(per.values(), key=lambda r: (r["company_id"], r["employee_id"]))


def w3_reconcile(company: Company, liabilities: list[Liability], rules: RuleBook, year: int) -> tuple[dict, list[Issue]]:
    """W-3 totals and the year-end W-2 <-> 941 reconciliation agencies run (CP-2100/AUR style)."""
    w2s = w2_records(liabilities, year, company.id)
    w3 = {b: sum((r[b] for r in w2s), ZERO) for b in ("box1", "box2", "box3", "box4", "box5", "box6", "box12_D")}
    w3["forms"] = len(w2s)
    quarters = [form_941(company, liabilities, rules, year, q) for q in (1, 2, 3, 4)]
    pairs = [("box1", "2", "wages (W-3 box 1 vs 941 line 2)"),
             ("box2", "3", "federal income tax (W-3 box 2 vs 941 line 3)"),
             ("box3", "5a.1", "social security wages (W-3 box 3 vs 941 line 5a)"),
             ("box5", "5c.1", "Medicare wages (W-3 box 5 vs 941 line 5c)")]
    issues = []
    for box, line, label in pairs:
        total_941 = sum((d.value(line) for d in quarters), ZERO)
        if total_941 != w3[box]:
            issues.append(Issue("error", "w3-941-mismatch",
                                f"{year} {label}: W-3 {fmt(w3[box])} vs 941s {fmt(total_941)}", company.id))
    _, year_end = quarter_bounds(year, 4)
    ss_rule = rules.taxes["FED_SS_EE"].version_for(year_end)
    ss_max = r2(ss_rule.wage_base * ss_rule.rate)
    for r in w2s:
        if r["box3"] > ss_rule.wage_base or r["box4"] > ss_max:
            issues.append(Issue("error", "w2-ss-over-max",
                                f"{year} W-2 {r['employee_id']}: SS wages {fmt(r['box3'])}, withheld {fmt(r['box4'])}; "
                                f"annual maximum is {fmt(ss_rule.wage_base)} wages, {fmt(ss_max)} tax — refund the excess",
                                company.id, r["employee_id"]))
        elif abs(r["box4"] - r2(r["box3"] * ss_rule.rate)) > Decimal("1.00"):
            issues.append(Issue("warning", "w2-ss-rate",
                                f"{year} W-2 {r['employee_id']}: box 4 {fmt(r['box4'])} is not {ss_rule.rate} x box 3",
                                company.id, r["employee_id"]))
    ss_owed = _sum([l for l in liabilities if l.company_id == company.id and l.pay_date.year == year], "FED_SS_EE")
    if abs(w3["box4"] - ss_owed) > Decimal("1.00"):
        issues.append(Issue("warning", "w3-ss-withheld",
                            f"{year} W-3 box 4 SS withheld {fmt(w3['box4'])} differs from SS owed {fmt(ss_owed)}",
                            company.id))
    return w3, issues


# --------------------------------------------------- state wage reports ---

def state_wage_report(company: Company, liabilities: list[Liability], rules: RuleBook, state: str,
                      year: int, quarter: int) -> ReturnDoc:
    start, end = quarter_bounds(year, quarter)
    q = [l for l in liabilities if l.company_id == company.id and start <= l.pay_date <= end
         and l.line.work_state == state]
    groups = sorted({l.deposit_group for l in q if l.jurisdiction == state})
    form = " / ".join(sorted({rules.groups[g].return_form for g in groups})) or "state wage report"
    doc = ReturnDoc(form, company.id, company.name, company.fein, f"{year} Q{quarter} {state}")
    acct = company.state_accounts.get(state, {})
    doc.add("acct", "State employer account", acct.get("account", "(not on file)"))

    emp: dict[str, dict] = {}
    for l in q:
        e = emp.setdefault(l.line.employee_id, {"employee_id": l.line.employee_id, "name": l.line.name,
                                                "ssn_last4": l.line.ssn[-4:], "gross": ZERO, "sui_subject": ZERO,
                                                "sui_taxable": ZERO, "sit_withheld": ZERO, "sdi_withheld": ZERO})
        if l.tax_code == f"{state}_SUI":
            e["gross"] += l.line.gross
            e["sui_subject"] += l.subject_wages
            e["sui_taxable"] += l.taxable_wages
        elif l.tax_code == f"{state}_SIT":
            e["sit_withheld"] += l.amount
        elif l.tax_code == f"{state}_SDI":
            e["sdi_withheld"] += l.amount
    doc.schedules["Employee wage detail"] = sorted(emp.values(), key=lambda e: e["employee_id"])
    doc.add("emp", "Employees reported", len(emp))
    doc.add("subject", "Total subject wages", sum((e["sui_subject"] for e in emp.values()), ZERO))
    doc.add("taxable", "Total UI taxable wages", sum((e["sui_taxable"] for e in emp.values()), ZERO))
    for code in sorted({l.tax_code for l in q if l.jurisdiction == state}):
        doc.add(code, rules.taxes[code].name, period_total([l for l in q if l.tax_code == code]))
    return doc


# ----------------------------------------------------------- amendments ---

X_MAP = [  # (941 line, 941-X line, label, tax rate source)
    ("2", "6", "Wages, tips and other compensation", None),
    ("3", "7", "Federal income tax withheld", "self"),
    ("5a.1", "8", "Taxable social security wages", ("FED_SS_EE", "FED_SS_ER")),
    ("5c.1", "10", "Taxable Medicare wages & tips", ("FED_MED_EE", "FED_MED_ER")),
    ("5d.1", "11", "Wages subject to Additional Medicare withholding", ("FED_ADDL_MED",)),
]


def amend_941(company: Company, original: list[Liability], corrected: list[Liability], rules: RuleBook,
              year: int, quarter: int) -> ReturnDoc:
    a = form_941(company, original, rules, year, quarter)
    b = form_941(company, corrected, rules, year, quarter)
    _, end = quarter_bounds(year, quarter)
    doc = ReturnDoc("941-X", company.id, company.name, company.fein, f"{year} Q{quarter}")
    rows, total = [], ZERO
    for src, xline, label, rate_src in X_MAP:
        orig, corr = a.value(src), b.value(src)
        diff = corr - orig
        if rate_src is None:
            tax = None
        elif rate_src == "self":
            tax = diff
        else:
            tax = r2(diff * sum((rules.taxes[c].version_for(end).rate for c in rate_src), ZERO))
        if tax is not None:
            total += tax
        rows.append({"941_x_line": xline, "941_line": src, "label": label, "corrected": corr,
                     "original": orig, "difference": diff, "tax_correction": tax if tax is not None else "-"})
        doc.add(xline, f"{label} — difference", diff)
    doc.add("23", "Total tax correction (positive = amount owed)", total)
    doc.schedules["Line detail (columns 1-4)"] = rows
    doc.notes.append("Choose interest-free adjustment (line 1) or claim (line 2) and file W-2c for affected employees.")
    return doc


W2_BOXES = ("box1", "box2", "box3", "box4", "box5", "box6", "box12_D", "box14_CASDI")


def w2c_records(original: list[Liability], corrected: list[Liability], year: int, company_id: str) -> list[dict]:
    a = {r["employee_id"]: r for r in w2_records(original, year, company_id)}
    b = {r["employee_id"]: r for r in w2_records(corrected, year, company_id)}
    out = []
    for emp in sorted(set(a) | set(b)):
        ra, rb = a.get(emp), b.get(emp)
        changes = {}
        for box in W2_BOXES:
            va = ra[box] if ra else ZERO
            vb = rb[box] if rb else ZERO
            if va != vb:
                changes[box] = {"previously_reported": va, "correct": vb}
        if changes:
            ref = rb or ra
            out.append({"employee_id": emp, "name": ref["name"], "ssn_last4": ref["ssn"][-4:], "changes": changes})
    return out
