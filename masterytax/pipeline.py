"""One object that runs import -> engine liabilities -> reconciliation -> deposits."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from .deposits import ObligationStatus, apply_deposits, build_obligations
from .engine import compute_liabilities, supported_states
from .importer import load_deposits, load_payroll
from .models import Company, EmployeeProfile, Issue, Liability, PayLine, load_companies, load_employees
from .money import ZERO
from .remittance import Remittance
from .returns import form_940, form_941


@dataclass
class Workspace:
    companies: dict[str, Company]
    remittance: Remittance
    profiles: dict[tuple[str, str], EmployeeProfile]
    lines: list[PayLine]
    liabilities: list[Liability]
    issues: list[Issue]
    obligations: list = field(default_factory=list)
    statuses: list[ObligationStatus] = field(default_factory=list)
    credits: list[dict] = field(default_factory=list)
    as_of: date = field(default_factory=date.today)

    @classmethod
    def load(cls, payroll, companies_path, deposits_path=None, employees_path=None, agencies_path=None,
             as_of: date | None = None) -> "Workspace":
        remittance = Remittance.load(agencies_path)
        companies = load_companies(companies_path)
        profiles = load_employees(employees_path)
        lines, issues = load_payroll(payroll, companies, supported_states())
        liabilities, engine_issues, lines = compute_liabilities(lines, companies, profiles, remittance)
        issues += engine_issues
        deposits = []
        if deposits_path:
            deposits, dep_issues = load_deposits(deposits_path)
            issues += dep_issues
        as_of = as_of or date.today()
        obligations = build_obligations(liabilities, companies, remittance)
        statuses, credits = apply_deposits(obligations, deposits, as_of)
        for st in statuses:
            ob = st.obligation
            if st.status in ("late", "overdue"):
                penalty = f"; est. FTD penalty {st.penalty}" if st.penalty else ""
                issues.append(Issue("error" if st.status == "overdue" else "warning", f"deposit-{st.status}",
                                    f"{ob.group} {ob.period} due {ob.due}: {st.days_late} days late, "
                                    f"outstanding {st.outstanding}{penalty}", ob.company_id))
        for c in credits:
            issues.append(Issue("info", "unapplied-deposit",
                                f"{c['deposit_group']} deposit on {c['date']} has {c['unapplied']} not matched to a liability",
                                c["company_id"]))
        flagged = set()
        for l in liabilities:
            key = (l.company_id, l.deposit_group)
            if key in flagged:
                continue
            flagged.add(key)
            group = remittance.group(l.deposit_group, companies[l.company_id])
            if not group.configured:
                issues.append(Issue("warning", "assumed-schedule",
                                    f"{group.code} deposit schedule not configured; using the federal schedule "
                                    f"(never later than most states) — set deposit_schedules.{group.code}",
                                    l.company_id))
        return cls(companies, remittance, profiles, lines, liabilities, issues, obligations, statuses, credits, as_of)

    def periods(self, company_id: str) -> list[tuple[int, int]]:
        return sorted({(l.year, l.quarter) for l in self.lines if l.company_id == company_id})

    def group(self, company_id: str, code: str):
        return self.remittance.group(code, self.companies[company_id])

    def deposits_applied(self, company_id: str, group: str, year: int, quarter: int | None = None) -> Decimal:
        return sum((st.paid for st in self.statuses
                    if st.obligation.company_id == company_id and st.obligation.group == group
                    and st.obligation.year == year and (quarter is None or st.obligation.quarter == quarter)), ZERO)

    def form_941(self, company_id: str, year: int, quarter: int):
        return form_941(self.companies[company_id], self.liabilities, year, quarter,
                        self.deposits_applied(company_id, "US-941", year, quarter), self.obligations)

    def form_940(self, company_id: str, year: int):
        return form_940(self.companies[company_id], self.liabilities, year,
                        self.deposits_applied(company_id, "US-940", year))

    def states(self, company_id: str) -> list[str]:
        return sorted({l.jurisdiction for l in self.liabilities if l.company_id == company_id and l.level == "state"})

    def liability_summary(self) -> dict[tuple, Decimal]:
        """(company, deposit group, tax code) -> total."""
        out: dict[tuple, Decimal] = defaultdict(lambda: ZERO)
        for l in self.liabilities:
            out[(l.company_id, l.deposit_group, l.tax_code)] += l.amount
        return dict(out)
