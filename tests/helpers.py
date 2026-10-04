from __future__ import annotations

from datetime import date
from decimal import Decimal

from masterytax.engine import compute_liabilities
from masterytax.models import Company, EmployeeProfile, PayLine
from masterytax.remittance import Remittance

REMIT = Remittance.load()


def company(cid="CO", schedule=None, lookback=None, accounts=None, schedules=None) -> Company:
    return Company(cid, f"{cid} Inc", "12-3456789", schedule,
                   Decimal(lookback) if lookback is not None else None, accounts or {}, schedules or {})


def profile(emp="E1", cid="CO", cert=None, **w4) -> EmployeeProfile:
    return EmployeeProfile(cid, emp, "biweekly", {"filingStatus": "single", **w4}, cert)


def line(pay_date, gross, emp="E1", cid="CO", state="TX", k401="0", s125="0", row=1, freq="biweekly",
         supplemental="0", **reported) -> PayLine:
    return PayLine(
        row=row, source="test", company_id=cid, employee_id=emp, ssn="512341001", first_name="Test",
        last_name=emp, pay_date=date.fromisoformat(pay_date) if isinstance(pay_date, str) else pay_date,
        work_state=state, gross=Decimal(gross),
        deductions={"deferral_401k": Decimal(k401), "section125": Decimal(s125)},
        reported={k: Decimal(v) for k, v in reported.items()}, pay_frequency=freq,
        supplemental=Decimal(supplemental))


def run(lines, companies=None, profiles=None):
    companies = companies or {"CO": company()}
    profiles = {(p.company_id, p.employee_id): p for p in (profiles or [])}
    liabs, issues, _ = compute_liabilities(lines, companies, profiles, REMIT)
    return liabs, issues


def liabilities(lines, companies=None, profiles=None):
    return run(lines, companies, profiles)[0]


def total(liabs, code, attr="amount") -> Decimal:
    return sum((getattr(l, attr) for l in liabs if l.tax_code == code), Decimal(0))


def codes(issues) -> set[str]:
    return {i.code for i in issues}
