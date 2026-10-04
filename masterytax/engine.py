"""Liabilities from the tax engine, with payroll's withholding checked against it.

Every paycheck goes through the vendored engine (federal + all states + DC +
local). Statutory taxes (FICA, FUTA, SUI, SDI, PFML ...) are owed as the
engine computes them, whatever payroll withheld. Income-tax withholding
(FIT, SIT, local) is owed as payroll actually withheld it; the engine's figure
is used to verify it when the employee's W-4 / state certificate is on file,
and is used outright when payroll reports no withholding at all.
"""

from __future__ import annotations

import re
from collections import defaultdict
from decimal import Decimal

from . import taxengine
from .models import REPORTED_COLUMNS, TAX_ID_COLUMN, Company, EmployeeProfile, Issue, Liability, PayLine
from .money import ZERO, D, fmt, r2
from .remittance import Remittance

DEFAULT_W4 = {"filingStatus": "single", "multipleJobs": False, "dependentCredit": 0, "otherIncome": 0,
              "deductions": 0, "extraWithholding": 0}
LOCAL_STATE = {"WILMINGTON_WAGE": "DE", "KC_EARN": "MO", "STL_EARN": "MO", "STL_PAYROLL_ER": "MO",
               "SEATTLE_PAYROLL_ER": "WA", "NEWARK_PAYROLL_ER": "NJ"}
WITHHOLDING_ID = re.compile(r"^(US_FIT(_SUPP)?|[A-Z]{2}_((NYC|YONKERS)_)?SIT(_.*)?)$")
NYC_YONKERS = re.compile(r"^[A-Z]{2}_(NYC|YONKERS)_SIT")
FLAT_LOCAL = {"PA_LST", "WV_LOCAL_FEE"}  # flat head taxes: owed exactly, not withholding estimates
WITHHOLDING_TOLERANCE = Decimal("1.00")  # whole-dollar rounding is permitted for income tax
STATUTORY_TOLERANCE = Decimal("0.01")


def cents(amount: Decimal) -> int:
    return int((amount * 100).quantize(Decimal(1)))


def dollars(c: int) -> Decimal:
    return (Decimal(c) / 100).quantize(Decimal("0.01"))


def infer_frequency(line: PayLine) -> str | None:
    if not (line.period_start and line.period_end):
        return None
    days = (line.period_end - line.period_start).days + 1
    if days <= 8:
        return "weekly"
    if days <= 14:
        return "biweekly"
    if days <= 16:
        return "semimonthly" if line.period_start.day in (1, 16) else "biweekly"
    if days <= 31:
        return "monthly"
    return "quarterly" if days <= 92 else "annual"


def _paycheck_input(line: PayLine, company: Company, profile: EmployeeProfile | None, freq: str) -> dict:
    regular = line.gross - line.supplemental
    earnings = [{"code": "REG", "category": "regular", "amount": cents(regular)}]
    if line.supplemental:
        earnings.append({"code": "SUPP", "category": "supplemental", "amount": cents(line.supplemental)})
    work = {"code": line.work_state}
    if profile and profile.work_certificate:
        work["certificate"] = profile.work_certificate
    employer: dict = {}
    rates = {st: float(company.state_rate(st)) for st in company.state_accounts if company.state_rate(st) is not None}
    if rates:
        employer["stateUnemploymentRate"] = rates
    reduced = {st: True for st, a in company.state_accounts.items() if (a or {}).get("reduced_wage_base")}
    if reduced:
        employer["stateUnemploymentQualifiedForReducedWageBase"] = reduced
    inp = {
        "checkDate": line.pay_date.isoformat(),
        "payFrequency": freq,
        "earnings": earnings,
        "deductions": [{"code": cat, "category": cat, "amount": cents(amt)}
                       for cat, amt in line.deductions.items() if amt],
        "federalW4": {**DEFAULT_W4, **((profile and profile.federal_w4) or {})},
        "workState": work,
        "employer": employer,
        "roundToWholeDollars": company.round_withholding,
    }
    if profile and profile.residence_state:
        inp["residenceState"] = profile.residence_state
    if profile and profile.residence_state_withholding:
        inp["residenceStateWithholding"] = profile.residence_state_withholding
    if profile and profile.employment_category:
        inp["employmentCategory"] = profile.employment_category
    if line.hours is not None:
        inp["hoursWorked"] = float(line.hours)
    return inp


def _jurisdiction(tax: dict, line: PayLine) -> str:
    if tax["jurisdiction"] == "federal":
        return "US"
    tid = tax["id"]
    if tid in LOCAL_STATE:
        return LOCAL_STATE[tid]
    m = re.match(r"^([A-Z]{2})_", tid)
    return m.group(1) if m else line.work_state


def _covers(column: str, tax: dict) -> bool:
    if tax["payer"] != "employee":
        return False
    if column == "local_withheld":
        return tax["jurisdiction"] == "local" or bool(NYC_YONKERS.match(tax["id"]))
    if column == "sit_withheld" and NYC_YONKERS.match(tax["id"]):
        return False
    return bool(REPORTED_COLUMNS[column].match(tax["id"]))


def _is_withholding(tax: dict) -> bool:
    """Income-tax withholding: owed as payroll withheld it, verified against W-4s."""
    if tax["id"] in FLAT_LOCAL:
        return False
    return bool(WITHHOLDING_ID.match(tax["id"])) or (tax["jurisdiction"] == "local" and tax["payer"] == "employee")


def _allocate(total: Decimal, computed: list[Decimal]) -> list[Decimal]:
    """Split a reported amount across lines in proportion to the engine's figures."""
    base = sum(computed, ZERO)
    if base == 0:
        return [total] + [ZERO] * (len(computed) - 1)
    parts = [r2(total * c / base) for c in computed]
    parts[0] += total - sum(parts, ZERO)
    return parts


class Engine:
    def __init__(self, companies: dict[str, Company], profiles: dict, remittance: Remittance):
        self.companies, self.profiles, self.remittance = companies, profiles, remittance
        self.issues: list[Issue] = []
        self._once: set = set()

    def _issue_once(self, key, issue: Issue):
        if key not in self._once:
            self._once.add(key)
            self.issues.append(issue)

    def run(self, lines: list[PayLine]) -> tuple[list[Liability], list[Issue], list[PayLine]]:
        """Returns (liabilities, issues, lines the engine accepted)."""
        batch, by_key, accepted = [], {}, []
        for seq, line in enumerate(lines):
            company = self.companies[line.company_id]
            profile = self.profiles.get((line.company_id, line.employee_id))
            if line.gross < 0:
                self.issues.append(Issue("error", "reversal-held",
                                         "negative paychecks are not netted silently; submit the corrected register "
                                         "with `masterytax amend` so wage bases are recomputed",
                                         line.company_id, line.employee_id, line.row, line.source))
                continue
            freq = line.pay_frequency or (profile and profile.pay_frequency) or infer_frequency(line)
            if not freq:
                freq = "biweekly"
                self._issue_once(("freq", line.company_id, line.employee_id), Issue(
                    "info", "assumed-frequency", "no pay_frequency or pay-period dates; assumed biweekly for "
                    "withholding", line.company_id, line.employee_id))
            key = f"{seq}"
            by_key[key] = line
            batch.append({"key": key, "companyId": line.company_id, "employeeId": line.employee_id, "seq": seq,
                          "input": _paycheck_input(line, company, profile, freq)})

        results = taxengine.run_paychecks(batch)
        liabilities: list[Liability] = []
        for key, line in by_key.items():
            res = results[key]
            if "error" in res:
                self.issues.append(Issue("error", "engine-refused", f"{res['errorType']}: {res['error']}",
                                         line.company_id, line.employee_id, line.row, line.source))
                continue
            accepted.append(line)
            liabilities += self._liabilities(line, res)
        self._account_checks(liabilities)
        return liabilities, self.issues, accepted

    # ----------------------------------------------------------------------

    def _liabilities(self, line: PayLine, res: dict) -> list[Liability]:
        company = self.companies[line.company_id]
        profile = self.profiles.get((line.company_id, line.employee_id))
        taxes = res["taxes"]
        computed = {t["id"]: dollars(t["amount"]) for t in taxes}
        claimed: dict[str, Decimal] = {}

        explicit = [c for c in line.reported if TAX_ID_COLUMN.match(c)]
        for col in explicit:
            claimed[col] = line.reported[col]
            if col not in computed:
                self.issues.append(Issue("warning", "reported-tax-not-owed",
                                         f"{line.pay_date} payroll withheld {fmt(line.reported[col])} for {col}, "
                                         f"which does not apply to this paycheck", line.company_id,
                                         line.employee_id, line.row, line.source))
            else:
                tax = next(t for t in taxes if t["id"] == col)
                self._compare(line, col, line.reported[col], computed[col], _is_withholding(tax), profile)

        for col in REPORTED_COLUMNS:
            if col not in line.reported:
                continue
            ids = [t["id"] for t in taxes if t["id"] not in explicit and _covers(col, t)]
            if not ids:
                if line.reported[col]:
                    self.issues.append(Issue("warning", "reported-tax-not-owed",
                                             f"{line.pay_date} payroll withheld {fmt(line.reported[col])} as {col}, "
                                             f"but no such tax applies in {line.work_state}", line.company_id,
                                             line.employee_id, line.row, line.source))
                continue
            for tid, part in zip(ids, _allocate(line.reported[col], [computed[i] for i in ids])):
                claimed[tid] = part
            is_wh = all(_is_withholding(t) for t in taxes if t["id"] in ids)
            self._compare(line, col, line.reported[col], sum((computed[i] for i in ids), ZERO), is_wh, profile)

        out = []
        sui_seen = set()
        for t in taxes:
            tid = t["id"]
            juris = _jurisdiction(t, line)
            withholding = _is_withholding(t)
            amount = claimed[tid] if withholding and tid in claimed else computed[tid]
            if withholding and tid not in claimed and computed[tid] and not (profile and profile.federal_w4):
                self._issue_once(("w4", line.company_id, line.employee_id), Issue(
                    "info", "computed-withholding",
                    "payroll reported no income-tax withholding and no W-4 is on file; withholding computed as "
                    "single with no adjustments (the IRS rule for a missing W-4)", line.company_id, line.employee_id))
            rate = self._rate(tid, juris, line, company)
            if tid.endswith("_SUI_ER"):
                sui_seen.add(juris)
            trace = t.get("detail") or ""
            if t.get("dataQuality"):
                dq = t["dataQuality"]
                trace += f" [data quality: {dq['tier']} — {dq['note']}]"
                self._issue_once(("dq", line.company_id, tid), Issue(
                    "warning", "data-quality", f"{tid}: {dq['tier']} — {dq['note']}", line.company_id))
            if withholding and tid in claimed:
                trace = f"withheld {fmt(amount)} as reported; engine computes {fmt(computed[tid])} ({trace})"
            out.append(Liability(
                line=line, tax_code=tid, jurisdiction=juris, level=t["jurisdiction"], payer=t["payer"],
                deposit_group=self.remittance.group_code(tid), taxable_wages=dollars(t["taxableWages"]),
                amount=amount, computed=computed[tid], reported=claimed.get(tid), trace=f"{tid}: {trace}",
                name=t.get("name", tid), rate=rate, withholding=withholding))

        for w in res.get("warnings", []):
            self.issues.append(Issue("warning", "engine-warning", f"{line.pay_date} {w}", line.company_id,
                                     line.employee_id, line.row, line.source))

        by_id = {l.tax_code: l for l in out}
        for levy in self.remittance.levies:
            base = by_id.get(levy.base_tax)
            if not base:
                continue
            rate = D(str(company.account_value(levy.state, levy.rate_key, levy.rate)))
            amount = r2(base.taxable_wages * rate)
            out.append(Liability(
                line=line, tax_code=levy.code, jurisdiction=levy.state, level="state", payer="employer",
                deposit_group=levy.group, taxable_wages=base.taxable_wages, amount=amount, computed=amount,
                reported=None, name=levy.name, rate=rate,
                trace=f"{levy.code}: {rate * 100:.4g}% x {levy.base_tax} taxable wages {fmt(base.taxable_wages)} "
                      f"= {fmt(amount)} [{levy.source}]"))
        if line.work_state not in sui_seen and line.gross > 0:
            st = line.work_state
            if company.state_rate(st) is None and taxengine.sui_new_employer_rate(st, line.year) is None:
                self._issue_once(("nosui", company.id, st), Issue(
                    "error", "no-sui-rate", f"{st} publishes no single new-employer SUI rate and none is on file; "
                    f"add state_accounts.{st}.sui_rate — no {st} SUI liability was computed", company.id))
        return out

    def _rate(self, tid: str, juris: str, line: PayLine, company: Company):
        if tid == "US_FUTA":
            return taxengine.futa_rates(line.year)["net"]
        if tid.endswith("_SUI_ER"):
            return company.state_rate(juris) or taxengine.sui_new_employer_rate(juris, line.year)
        return None

    def _compare(self, line, column, reported, computed, is_withholding, profile):
        if is_withholding:
            if not (profile and profile.federal_w4):
                return  # nothing to verify against without the employee's certificates
            tolerance = WITHHOLDING_TOLERANCE
        else:
            tolerance = STATUTORY_TOLERANCE
        diff = reported - computed
        if abs(diff) > tolerance:
            direction = "over" if diff > 0 else "under"
            self.issues.append(Issue(
                "warning", f"{direction}-withheld",
                f"{line.pay_date} {column}: payroll withheld {fmt(reported)}, engine computes {fmt(computed)} "
                f"({direction} by {fmt(abs(diff))})", line.company_id, line.employee_id, line.row, line.source))

    def _account_checks(self, liabilities: list[Liability]):
        for l in liabilities:
            company = self.companies[l.company_id]
            if l.level != "state" or l.jurisdiction not in taxengine.covered_states(l.line.year):
                continue
            st = l.jurisdiction
            if st not in company.state_accounts:
                self._issue_once(("reg", company.id, st), Issue(
                    "warning", "not-registered", f"employees are paid in {st} but no {st} account is on file "
                    f"(register for withholding / UI before filing)", company.id))
            if l.tax_code.endswith("_SUI_ER") and company.state_rate(st) is None and l.rate is not None:
                self._issue_once(("defsui", company.id, st), Issue(
                    "warning", "default-sui-rate",
                    f"no {st} SUI rate on file; engine used the new-employer rate {l.rate * 100:.4g}%", company.id))


def compute_liabilities(lines, companies, profiles, remittance):
    return Engine(companies, profiles, remittance).run(lines)


def period_total(liabilities: list[Liability]) -> Decimal:
    """Total owed for a filing period the way agencies figure it on the return.

    Employer contributions with a known rate (SUI, ETT, FUTA at the net rate)
    are total taxable wages x rate, not a sum of per-check rounded amounts;
    everything else sums.
    """
    total = ZERO
    wages: dict[tuple, Decimal] = defaultdict(lambda: ZERO)
    for l in liabilities:
        if l.payer == "employer" and l.rate is not None and l.deposit_group != "US-941":
            wages[(l.tax_code, l.rate)] += l.taxable_wages
        else:
            total += l.amount
    return total + sum((r2(w * rate) for (_, rate), w in wages.items()), ZERO)


def supported_states() -> set[str]:
    out: set[str] = set()
    for y in taxengine.covered_years():
        out |= set(taxengine.covered_states(y))
    return out
