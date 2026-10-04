from __future__ import annotations

from datetime import date
from decimal import Decimal

from masterytax.engine import compute_liabilities
from masterytax.models import Company, PayLine
from masterytax.rules import RuleBook

RULES = RuleBook.load()


def company(cid="CO", schedule=None, lookback=None, accounts=None) -> Company:
    return Company(cid, f"{cid} Inc", "12-3456789", schedule,
                   Decimal(lookback) if lookback is not None else None, accounts or {})


def line(pay_date, gross, emp="E1", cid="CO", state="TX", k401="0", s125="0", row=1, **reported) -> PayLine:
    return PayLine(
        row=row, source="test", company_id=cid, employee_id=emp, ssn="512341001", first_name="Test",
        last_name=emp, pay_date=date.fromisoformat(pay_date) if isinstance(pay_date, str) else pay_date,
        work_state=state, gross=Decimal(gross), deductions={"k401": Decimal(k401), "s125": Decimal(s125)},
        reported={k: Decimal(v) for k, v in reported.items()})


def liabilities(lines, companies=None):
    companies = companies or {"CO": company()}
    return compute_liabilities(lines, companies, RULES)


def total(liabs, code, attr="amount") -> Decimal:
    return sum((getattr(l, attr) for l in liabs if l.tax_code == code), Decimal(0))
