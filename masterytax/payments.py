"""Payment instructions for open deposit obligations.

MasteryTax never moves money. This turns what is owed into the exact
instructions a person (or a licensed payment provider) would act on: payee,
tax type, period, amount and the date the payment must be initiated by.
"""

from __future__ import annotations

from datetime import date, timedelta

from .bizcal import is_business_day, quarter_bounds
from .deposits import ObligationStatus
from .models import Company
from .money import ZERO
from .remittance import DepositGroup

NOT_TRANSMITTED = "NOT TRANSMITTED — instructions only; MasteryTax does not move money"


def previous_business_day(d: date) -> date:
    d -= timedelta(days=1)
    while not is_business_day(d):
        d -= timedelta(days=1)
    return d


def tax_period_end(group: DepositGroup, year: int, quarter: int) -> date:
    """EFTPS tax period: quarter end for 941, Dec 31 for 940/CT-1/annual returns."""
    if group.return_form in ("940", "CT-1") or group.schedule == "annual":
        return date(year, 12, 31)
    return quarter_bounds(year, quarter)[1]


def account_for(company: Company, group_code: str) -> str:
    """The agency account to quote: a per-group account, else the state's own for state-level groups."""
    explicit = (company.deposit_schedules.get(group_code) or {}).get("account")
    if explicit:
        return explicit
    st, _, kind = group_code.partition("-")
    acct = company.state_accounts.get(st) or {}
    if f"{kind.lower()}_account" in acct:
        return acct[f"{kind.lower()}_account"]
    return acct.get("account", "") if kind in ("WH", "UI", "PFML", "DI", "LTC") else ""


def instructions(statuses: list[ObligationStatus], companies: dict[str, Company], group_for, as_of: date,
                 include_optional: bool = False) -> list[dict]:
    out = []
    for st in statuses:
        ob = st.obligation
        if st.outstanding <= ZERO or (ob.optional and not include_optional):
            continue
        company = companies[ob.company_id]
        group = group_for(ob.company_id, ob.group)
        account = account_for(company, ob.group)
        federal = group.agency == "IRS"
        initiate_by = previous_business_day(ob.due) if federal else ob.due
        out.append({
            "company_id": company.id,
            "fein": company.fein,
            "payee": group.agency,
            "deposit_group": ob.group,
            "return": group.return_form,
            "method": "EFTPS (ACH debit)" if federal else "agency e-payment / ACH credit",
            "eftps_tax_type": group.eftps_tax_type or "",
            "tax_period_end": tax_period_end(group, ob.year, ob.quarter).isoformat(),
            "liability_period": ob.period,
            "state_account": account,
            "amount": st.outstanding,
            "due": ob.due.isoformat(),
            "initiate_by": initiate_by.isoformat(),
            "past_due": ob.due < as_of,
            "optional": ob.optional,
            "status": NOT_TRANSMITTED,
        })
    return sorted(out, key=lambda r: (r["initiate_by"], r["company_id"], r["deposit_group"]))
