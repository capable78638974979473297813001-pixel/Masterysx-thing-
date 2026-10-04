"""Core records: companies, employee tax profiles, payroll lines, liabilities, issues."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path

from .bizcal import quarter_of
from .money import D

# Payroll-register column -> the engine's pre-tax deduction category.
DEDUCTION_COLUMNS = {
    "pretax_401k": "deferral_401k",
    "pretax_403b": "deferral_403b",
    "pretax_457": "deferral_457",
    "pretax_simple": "deferral_simple",
    "pretax_s125": "section125",
    "pretax_hsa": "hsa",
    "pretax_fsa": "fsa",
    "pretax_dependent_care": "dependent_care",
    "pretax_commuter": "commuter",
}

# What payroll says it withheld. Each legacy column covers a family of engine
# tax ids; a column named exactly like an engine tax id (e.g. NY_PFML_EE)
# reports that one tax and takes precedence over the family column.
REPORTED_COLUMNS = {
    "fit_withheld": re.compile(r"^US_FIT(_SUPP)?$"),
    "ss_withheld": re.compile(r"^US_SS_EE$"),
    "medicare_withheld": re.compile(r"^US_MED_(EE|ADDL)$"),
    "sit_withheld": re.compile(r"^[A-Z]{2}_SIT"),
    "sdi_withheld": re.compile(r"^[A-Z]{2}_(DBL|PFML|UC|LTC)_EE$"),
    "local_withheld": None,  # every employee local tax line, plus NYC / Yonkers
}
TAX_ID_COLUMN = re.compile(r"^[A-Z]{2,}_[A-Z0-9_]+$")


@dataclass(frozen=True)
class Company:
    id: str
    name: str
    fein: str
    federal_schedule: str | None = None  # "monthly" | "semiweekly"; derived from lookback when absent
    lookback_941_liability: Decimal | None = None
    state_accounts: dict = field(default_factory=dict)
    deposit_schedules: dict = field(default_factory=dict)
    round_withholding: bool = False  # whole-dollar FIT/SIT, as IRS permits
    address: dict = field(default_factory=dict)
    contact: dict = field(default_factory=dict)

    def state_rate(self, state: str) -> Decimal | None:
        acct = self.state_accounts.get(state) or {}
        return D(acct["sui_rate"]) if "sui_rate" in acct else None

    def account_value(self, state: str, key: str, default=None):
        return (self.state_accounts.get(state) or {}).get(key, default)


def load_companies(path: str | Path) -> dict[str, Company]:
    raw = json.loads(Path(path).read_text())
    out = {}
    for c in raw["companies"]:
        out[c["id"]] = Company(
            id=c["id"],
            name=c["name"],
            fein=c["fein"],
            federal_schedule=c.get("federal_schedule"),
            lookback_941_liability=D(c["lookback_941_liability"]) if "lookback_941_liability" in c else None,
            state_accounts=c.get("state_accounts", {}),
            deposit_schedules=c.get("deposit_schedules", {}),
            round_withholding=bool(c.get("round_withholding_to_whole_dollars", False)),
            address=c.get("address", {}),
            contact=c.get("contact", {}),
        )
    return out


@dataclass(frozen=True)
class EmployeeProfile:
    """W-4 and state/local certificates — what the engine needs to verify withholding."""
    company_id: str
    employee_id: str
    pay_frequency: str | None = None
    federal_w4: dict | None = None
    work_certificate: dict | None = None
    residence_state: dict | None = None  # {"code": "NJ", "certificate": {...}}
    residence_state_withholding: dict | None = None
    employment_category: str | None = None
    address: dict = field(default_factory=dict)


def load_employees(path: str | Path | None) -> dict[tuple[str, str], EmployeeProfile]:
    if not path:
        return {}
    raw = json.loads(Path(path).read_text())
    out = {}
    for e in raw["employees"]:
        p = EmployeeProfile(
            company_id=e["company_id"], employee_id=e["employee_id"], pay_frequency=e.get("pay_frequency"),
            federal_w4=e.get("federal_w4"), work_certificate=e.get("work_state_certificate"),
            residence_state=e.get("residence_state"), residence_state_withholding=e.get("residence_state_withholding"),
            employment_category=e.get("employment_category"), address=e.get("address", {}))
        out[(p.company_id, p.employee_id)] = p
    return out


@dataclass(frozen=True)
class PayLine:
    row: int
    source: str
    company_id: str
    employee_id: str
    ssn: str
    first_name: str
    last_name: str
    pay_date: date
    work_state: str
    gross: Decimal
    deductions: dict  # engine pre-tax category -> Decimal
    reported: dict  # reported column (legacy name or engine tax id) -> Decimal
    period_start: date | None = None
    period_end: date | None = None
    pay_frequency: str | None = None
    supplemental: Decimal = Decimal(0)  # portion of gross that is bonus/commission
    hours: Decimal | None = None

    @property
    def year(self) -> int:
        return self.pay_date.year

    @property
    def quarter(self) -> int:
        return quarter_of(self.pay_date)

    @property
    def name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()

    def exempt(self, categories) -> Decimal:
        return sum((self.deductions.get(c, Decimal(0)) for c in categories), Decimal(0))


@dataclass(frozen=True)
class Liability:
    line: PayLine
    tax_code: str
    jurisdiction: str  # "US", a state code, or a state code for a local tax
    level: str  # "federal" | "state" | "local"
    payer: str
    deposit_group: str
    taxable_wages: Decimal
    amount: Decimal  # what is owed: reported withholding, otherwise the computed tax
    computed: Decimal  # the engine's figure
    reported: Decimal | None
    trace: str
    name: str = ""
    rate: Decimal | None = None  # employer contribution rate, where known
    withholding: bool = False  # income-tax withholding (reported basis) vs statutory tax

    @property
    def company_id(self) -> str:
        return self.line.company_id

    @property
    def pay_date(self) -> date:
        return self.line.pay_date

    @property
    def subject_wages(self) -> Decimal:
        return self.taxable_wages


@dataclass(frozen=True)
class Issue:
    severity: str  # "error" | "warning" | "info"
    code: str
    message: str
    company_id: str = ""
    employee_id: str = ""
    row: int | None = None
    source: str = ""

    def as_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v not in ("", None)}
