"""Return builders: Form 941 (+ Schedule B), Form 940 (+ Schedule A), W-2/W-3,
state quarterly wage reports, and amendments (941-X / W-2c) by recomputation.

Each return is plain data (lines with labels) so it can be rendered, diffed,
exported or mapped to an e-file format without re-deriving numbers.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from . import taxengine
from .bizcal import quarter_bounds
from .deposits import Obligation, federal_schedule, futa_credit_reduction
from .engine import NYC_YONKERS, period_total
from .models import Company, Issue, Liability
from .money import ZERO, fmt, r2
from .remittance import Remittance

FIT_CODES = ("US_FIT", "US_FIT_SUPP")
FICA_CODES = ("US_SS_EE", "US_SS_ER", "US_MED_EE", "US_MED_ER", "US_MED_ADDL")
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


def _sum(liabs, codes, attr="amount") -> Decimal:
    codes = (codes,) if isinstance(codes, str) else codes
    return sum((getattr(l, attr) for l in liabs if l.tax_code in codes), ZERO)


def _withheld(l: Liability) -> Decimal:
    """What actually left the employee's pay: payroll's figure when reported."""
    return l.reported if l.reported is not None else l.amount


# ------------------------------------------------------------------ 941 ---

def form_941(company: Company, liabilities: list[Liability], year: int, quarter: int,
             deposits: Decimal = ZERO, obligations: list[Obligation] | None = None) -> ReturnDoc:
    start, end = quarter_bounds(year, quarter)
    q = [l for l in liabilities if l.company_id == company.id and start <= l.pay_date <= end]
    doc = ReturnDoc("941", company.id, company.name, company.fein, f"{year} Q{quarter}")

    twelfth = date(year, quarter * 3, 12)
    employees, used_month_fallback = set(), False
    for l in q:
        if l.tax_code != "US_FIT":
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

    rates = taxengine.fica_rates(year)
    ss, med, addl = rates["ss"], rates["med"], rates["addl"]

    doc.add("1", f"Employees paid for the pay period including {twelfth:%b %d}", len(employees))
    doc.add("2", "Wages, tips, and other compensation", _sum(q, FIT_CODES, "taxable_wages"))
    l3 = doc.add("3", "Federal income tax withheld", _sum(q, FIT_CODES))
    ss_w = doc.add("5a.1", "Taxable social security wages", _sum(q, "US_SS_EE", "taxable_wages"))
    ss_t = doc.add("5a.2", f"Social security tax (x {ss})", r2(ss_w * ss))
    med_w = doc.add("5c.1", "Taxable Medicare wages & tips", _sum(q, "US_MED_EE", "taxable_wages"))
    med_t = doc.add("5c.2", f"Medicare tax (x {med})", r2(med_w * med))
    addl_w = doc.add("5d.1", "Wages subject to Additional Medicare withholding", _sum(q, "US_MED_ADDL", "taxable_wages"))
    addl_t = doc.add("5d.2", f"Additional Medicare tax (x {addl})", r2(addl_w * addl))
    l5e = doc.add("5e", "Total social security and Medicare taxes", ss_t + med_t + addl_t)
    l6 = doc.add("6", "Total taxes before adjustments", l3 + l5e)
    actual_fica = _sum(q, FICA_CODES)
    l7 = doc.add("7", "Current quarter's adjustment for fractions of cents", actual_fica - l5e)
    l10 = doc.add("10", "Total taxes after adjustments", l6 + l7)
    l12 = doc.add("12", "Total taxes after adjustments and nonrefundable credits", l10)
    l13 = doc.add("13", "Total deposits for this quarter", deposits)
    doc.add("14", "Balance due", max(l12 - l13, ZERO))
    doc.add("15", "Overpayment", max(l13 - l12, ZERO))
    if abs(l7) > Decimal("1.00") * max(1, len({l.line.row for l in q})):
        doc.notes.append("Line 7 is larger than per-check rounding explains — review withholding variances.")

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

def form_940(company: Company, liabilities: list[Liability], year: int, deposits: Decimal = ZERO) -> ReturnDoc:
    y = [l for l in liabilities if l.company_id == company.id and l.pay_date.year == year and l.tax_code == "US_FUTA"]
    doc = ReturnDoc("940", company.id, company.name, company.fein, str(year))
    futa = taxengine.futa_rates(year)
    rate = futa["net"]
    exempt_cats = taxengine.federal_exempt(year, "futa")
    states = sorted({l.line.work_state for l in y})
    if len(states) == 1:
        doc.add("1a", "State where you paid state unemployment tax", states[0])
    else:
        doc.add("1b", "Multi-state employer (see Schedule A)", ", ".join(states))
    total = doc.add("3", "Total payments to all employees", sum((l.line.gross for l in y), ZERO))
    exempt = doc.add("4", "Payments exempt from FUTA tax", sum((l.line.exempt(exempt_cats) for l in y), ZERO))
    subject = total - exempt
    taxable = sum((l.taxable_wages for l in y), ZERO)
    doc.add("5", f"Total of payments made to each employee in excess of ${futa['base']:,.0f}", subject - taxable)
    l6 = doc.add("6", "Subtotal (line 4 + line 5)", exempt + subject - taxable)
    l7 = doc.add("7", "Total taxable FUTA wages", total - l6)
    l8 = doc.add("8", f"FUTA tax before adjustments (x {rate})", r2(l7 * rate))
    cr, cr_detail = futa_credit_reduction(y, year)
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
        {"state": st, "futa_taxable_wages": w, "credit_reduction_rate": futa["credit_reductions"].get(st, ZERO),
         "credit_reduction": cr_detail.get(st, ZERO)} for st, w in sorted(wages_by_state.items())]
    if not futa["credit_reductions"] and futa["determination_date"] and date.today().isoformat() < futa["determination_date"]:
        doc.notes.append(f"{year} credit-reduction states are determined after {futa['determination_date']}; "
                         "line 11 may change when DOL publishes them.")
    return doc


# ------------------------------------------------------------- W-2 / W-3 ---

BOX14_LABELS = {"CA_DBL_EE": "CASDI", "NY_PFML_EE": "NY PFL", "NY_DBL_EE": "NY SDI", "NJ_UC_EE": "NJ UI/WF/SWF",
                "NJ_DBL_EE": "NJ DI", "NJ_PFML_EE": "NJ FLI", "PA_UC_EE": "PA UC", "WA_PFML_EE": "WA PFML",
                "WA_LTC_EE": "WA CARES", "MA_PFML_EE": "MA PFML", "CO_PFML_EE": "CO FAMLI", "OR_PFML_EE": "OR PFL",
                "RI_DBL_EE": "RI TDI", "HI_DBL_EE": "HI TDI", "CT_PFML_EE": "CT PL", "DE_PFML_EE": "DE PFML",
                "MN_PFML_EE": "MN PL", "ME_PFML_EE": "ME PFML", "MD_PFML_EE": "MD FAMLI"}
# Local income taxes that use the state's wage definition: W-2 box 18 shows the state wages.
STATE_CONFORMING_LOCAL = re.compile(r"^[A-Z]{2}_(NYC|YONKERS)_SIT|^MI_LOCAL$|^IN_COUNTY$")
W2_DEFERRAL_CODES = {"deferral_401k": "D", "deferral_403b": "E", "deferral_457": "G", "deferral_simple": "S",
                     "hsa": "W"}
SIT_ID = re.compile(r"^([A-Z]{2})_SIT")


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
            "first_name": line.first_name, "last_name": line.last_name,
            "box1": ZERO, "box2": ZERO, "box3": ZERO, "box4": ZERO, "box5": ZERO, "box6": ZERO, "box10": ZERO,
            "box12": {}, "box14": {}, "states": {}, "locals": {}})
        rec["box1"] += _sum(group, FIT_CODES, "taxable_wages")
        rec["box2"] += sum((_withheld(l) for l in group if l.tax_code in FIT_CODES), ZERO)
        rec["box3"] += _sum(group, "US_SS_EE", "taxable_wages")
        rec["box4"] += sum((_withheld(l) for l in group if l.tax_code == "US_SS_EE"), ZERO)
        rec["box5"] += _sum(group, "US_MED_EE", "taxable_wages")
        rec["box6"] += sum((_withheld(l) for l in group if l.tax_code in ("US_MED_EE", "US_MED_ADDL")), ZERO)
        rec["box10"] += line.deductions.get("dependent_care", ZERO)
        for cat, code in W2_DEFERRAL_CODES.items():
            if line.deductions.get(cat):
                rec["box12"][code] = rec["box12"].get(code, ZERO) + line.deductions[cat]
        sit_states = set()
        for l in group:
            if l.level == "state" and l.payer == "employee" and not l.withholding:
                label = BOX14_LABELS.get(l.tax_code, f"{l.jurisdiction} {l.name}")
                rec["box14"][label] = rec["box14"].get(label, ZERO) + _withheld(l)
            m = SIT_ID.match(l.tax_code)
            if m and l.withholding and l.level == "state":
                st = rec["states"].setdefault(m.group(1), {"box16": ZERO, "box17": ZERO})
                if m.group(1) not in sit_states:
                    sit_states.add(m.group(1))
                    st["box16"] += line.gross - line.exempt(taxengine.exempt_pretax(m.group(1), year))
                st["box17"] += _withheld(l)
            if l.payer == "employee" and (l.level == "local" or NYC_YONKERS.match(l.tax_code)):
                loc = rec["locals"].setdefault(l.name or l.tax_code, {"state": l.jurisdiction, "box18": ZERO, "box19": ZERO})
                if STATE_CONFORMING_LOCAL.match(l.tax_code):
                    loc["box18"] += line.gross - line.exempt(taxengine.exempt_pretax(l.jurisdiction, year))
                elif l.tax_code not in ("PA_LST", "WV_LOCAL_FEE"):
                    loc["box18"] += l.taxable_wages
                loc["box19"] += _withheld(l)
    return sorted(per.values(), key=lambda r: (r["company_id"], r["employee_id"]))


def w2_flat(rec: dict) -> dict:
    """Every W-2 box as one flat {label: amount} map (for W-2c diffs and exports)."""
    out = {b: rec[b] for b in ("box1", "box2", "box3", "box4", "box5", "box6", "box10")}
    out.update({f"box12{code}": v for code, v in rec["box12"].items()})
    out.update({f"box14 {k}": v for k, v in rec["box14"].items()})
    for st, v in rec["states"].items():
        out[f"box16 {st}"], out[f"box17 {st}"] = v["box16"], v["box17"]
    for name, v in rec["locals"].items():
        out[f"box18 {name}"], out[f"box19 {name}"] = v["box18"], v["box19"]
    return out


def w3_reconcile(company: Company, liabilities: list[Liability], year: int) -> tuple[dict, list[Issue]]:
    """W-3 totals and the year-end W-2 <-> 941 reconciliation agencies run (CP-2100/AUR style)."""
    w2s = w2_records(liabilities, year, company.id)
    w3 = {b: sum((r[b] for r in w2s), ZERO) for b in ("box1", "box2", "box3", "box4", "box5", "box6", "box10")}
    w3["box12D"] = sum((r["box12"].get("D", ZERO) for r in w2s), ZERO)
    w3["forms"] = len(w2s)
    quarters = [form_941(company, liabilities, year, q) for q in (1, 2, 3, 4)]
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
    rates = taxengine.fica_rates(year)
    ss_max = r2(rates["ss_base"] * rates["ss_ee"])
    for r in w2s:
        if r["box3"] > rates["ss_base"] or r["box4"] > ss_max:
            issues.append(Issue("error", "w2-ss-over-max",
                                f"{year} W-2 {r['employee_id']}: SS wages {fmt(r['box3'])}, withheld {fmt(r['box4'])}; "
                                f"annual maximum is {fmt(rates['ss_base'])} wages, {fmt(ss_max)} tax — refund the excess",
                                company.id, r["employee_id"]))
        elif abs(r["box4"] - r2(r["box3"] * rates["ss_ee"])) > Decimal("1.00"):
            issues.append(Issue("warning", "w2-ss-rate",
                                f"{year} W-2 {r['employee_id']}: box 4 {fmt(r['box4'])} is not {rates['ss_ee']} x box 3",
                                company.id, r["employee_id"]))
    ss_owed = _sum([l for l in liabilities if l.company_id == company.id and l.pay_date.year == year], "US_SS_EE")
    if abs(w3["box4"] - ss_owed) > Decimal("1.00"):
        issues.append(Issue("warning", "w3-ss-withheld",
                            f"{year} W-3 box 4 SS withheld {fmt(w3['box4'])} differs from SS owed {fmt(ss_owed)}",
                            company.id))
    return w3, issues


# --------------------------------------------------- state wage reports ---

def state_wage_report(company: Company, liabilities: list[Liability], remittance: Remittance, state: str,
                      year: int, quarter: int) -> ReturnDoc:
    start, end = quarter_bounds(year, quarter)
    q = [l for l in liabilities if l.company_id == company.id and start <= l.pay_date <= end
         and l.jurisdiction == state]
    groups = sorted({l.deposit_group for l in q})
    form = " / ".join(sorted({remittance.group(g, company).return_form for g in groups})) or "state wage report"
    doc = ReturnDoc(form, company.id, company.name, company.fein, f"{year} Q{quarter} {state}")
    acct = company.state_accounts.get(state, {})
    doc.add("acct", "State employer account", acct.get("account", "(not on file)"))

    emp: dict[str, dict] = {}
    seen_lines: set[int] = set()
    for l in q:
        e = emp.setdefault(l.line.employee_id, {"employee_id": l.line.employee_id, "name": l.line.name,
                                                "ssn_last4": l.line.ssn[-4:], "gross": ZERO, "ui_taxable": ZERO,
                                                "income_tax_withheld": ZERO, "other_employee_taxes": ZERO})
        if id(l.line) not in seen_lines and l.line.work_state == state:
            seen_lines.add(id(l.line))
            e["gross"] += l.line.gross
        if l.tax_code == f"{state}_SUI_ER":
            e["ui_taxable"] += l.taxable_wages
        elif l.withholding:
            e["income_tax_withheld"] += _withheld(l)
        elif l.payer == "employee":
            e["other_employee_taxes"] += _withheld(l)
    doc.schedules["Employee wage detail"] = sorted(emp.values(), key=lambda e: e["employee_id"])
    doc.add("emp", "Employees reported", len(emp))
    doc.add("gross", "Total gross wages", sum((e["gross"] for e in emp.values()), ZERO))
    doc.add("taxable", "Total UI taxable wages", sum((e["ui_taxable"] for e in emp.values()), ZERO))
    for code in sorted({l.tax_code for l in q}):
        ls = [l for l in q if l.tax_code == code]
        doc.add(code, f"{ls[0].name} ({remittance.group(ls[0].deposit_group, company).agency})", period_total(ls))
    return doc


# ----------------------------------------------------------- amendments ---

X_MAP = [  # (941 line, 941-X line, label, rate key in taxengine.fica_rates)
    ("2", "6", "Wages, tips and other compensation", None),
    ("3", "7", "Federal income tax withheld", "self"),
    ("5a.1", "8", "Taxable social security wages", "ss"),
    ("5c.1", "10", "Taxable Medicare wages & tips", "med"),
    ("5d.1", "11", "Wages subject to Additional Medicare withholding", "addl"),
]


def amend_941(company: Company, original: list[Liability], corrected: list[Liability],
              year: int, quarter: int) -> ReturnDoc:
    a = form_941(company, original, year, quarter)
    b = form_941(company, corrected, year, quarter)
    rates = taxengine.fica_rates(year)
    doc = ReturnDoc("941-X", company.id, company.name, company.fein, f"{year} Q{quarter}")
    rows, total = [], ZERO
    for src, xline, label, rate_key in X_MAP:
        orig, corr = a.value(src), b.value(src)
        diff = corr - orig
        if rate_key is None:
            tax = None
        elif rate_key == "self":
            tax = diff
        else:
            tax = r2(diff * rates[rate_key])
        if tax is not None:
            total += tax
        rows.append({"941_x_line": xline, "941_line": src, "label": label, "corrected": corr,
                     "original": orig, "difference": diff, "tax_correction": tax if tax is not None else "-"})
        doc.add(xline, f"{label} — difference", diff)
    doc.add("23", "Total tax correction (positive = amount owed)", total)
    doc.schedules["Line detail (columns 1-4)"] = rows
    doc.notes.append("Choose interest-free adjustment (line 1) or claim (line 2) and file W-2c for affected employees.")
    return doc


def w2c_records(original: list[Liability], corrected: list[Liability], year: int, company_id: str) -> list[dict]:
    a = {r["employee_id"]: r for r in w2_records(original, year, company_id)}
    b = {r["employee_id"]: r for r in w2_records(corrected, year, company_id)}
    out = []
    for emp in sorted(set(a) | set(b)):
        fa = w2_flat(a[emp]) if emp in a else {}
        fb = w2_flat(b[emp]) if emp in b else {}
        changes = {box: {"previously_reported": fa.get(box, ZERO), "correct": fb.get(box, ZERO)}
                   for box in sorted(set(fa) | set(fb)) if fa.get(box, ZERO) != fb.get(box, ZERO)}
        if changes:
            ref = b.get(emp) or a[emp]
            out.append({"employee_id": emp, "name": ref["name"], "ssn_last4": ref["ssn"][-4:], "changes": changes})
    return out
