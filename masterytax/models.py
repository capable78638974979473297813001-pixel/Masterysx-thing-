"""Core records: companies, payroll lines, computed liabilities and issues."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path

from .bizcal import quarter_of
from .money import D

DEDUCTION_COLUMNS = {"pretax_401k": "k401", "pretax_s125": "s125"}
REPORTED_COLUMNS = ("fit_withheld", "ss_withheld", "medicare_withheld", "sit_withheld", "sdi_withheld")


@dataclass(frozen=True)
class Company:
    id: str
    name: str
    fein: str
    federal_schedule: str | None = None  # "monthly" | "semiweekly"; derived from lookback when absent
    lookback_941_liability: Decimal | None = None
    state_accounts: dict = field(default_factory=dict)

    def state_rate(self, state: str) -> Decimal | None:
        acct = self.state_accounts.get(state) or {}
        return D(acct["sui_rate"]) if "sui_rate" in acct else None


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
        )
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
    deductions: dict  # "k401" | "s125" -> Decimal
    reported: dict  # reported column -> Decimal (only columns present in the file)
    period_start: date | None = None
    period_end: date | None = None

    @property
    def year(self) -> int:
        return self.pay_date.year

    @property
    def quarter(self) -> int:
        return quarter_of(self.pay_date)

    @property
    def name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()


@dataclass(frozen=True)
class Liability:
    line: PayLine
    tax_code: str
    jurisdiction: str
    payer: str
    deposit_group: str
    subject_wages: Decimal
    taxable_wages: Decimal
    amount: Decimal
    trace: str
    rate: Decimal | None = None  # None for reported withholding

    @property
    def company_id(self) -> str:
        return self.line.company_id

    @property
    def pay_date(self) -> date:
        return self.line.pay_date


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
