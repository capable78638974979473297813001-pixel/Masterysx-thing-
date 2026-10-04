"""One object that runs import -> liabilities -> reconciliation -> deposits."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from .deposits import ObligationStatus, apply_deposits, build_obligations
from .engine import compute_liabilities, reconcile_withholding
from .importer import load_deposits, load_payroll
from .models import Company, Issue, Liability, PayLine, load_companies
from .money import ZERO
from .returns import form_940, form_941
from .rules import RuleBook


@dataclass
class Workspace:
    companies: dict[str, Company]
    rules: RuleBook
    lines: list[PayLine]
    liabilities: list[Liability]
    issues: list[Issue]
    obligations: list = field(default_factory=list)
    statuses: list[ObligationStatus] = field(default_factory=list)
    credits: list[dict] = field(default_factory=list)
    as_of: date = field(default_factory=date.today)

    @classmethod
    def load(cls, payroll, companies_path, deposits_path=None, rules_path=None, as_of: date | None = None) -> "Workspace":
        rules = RuleBook.load(rules_path)
        companies = load_companies(companies_path)
        lines, issues = load_payroll(payroll, companies, rules.supported_states())
        liabilities = compute_liabilities(lines, companies, rules)
        issues += reconcile_withholding(liabilities, companies, rules)
        deposits = []
        if deposits_path:
            deposits, dep_issues = load_deposits(deposits_path)
            issues += dep_issues
        as_of = as_of or date.today()
        obligations = build_obligations(liabilities, companies, rules)
        statuses, credits = apply_deposits(obligations, deposits, rules, as_of)
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
        return cls(companies, rules, lines, liabilities, issues, obligations, statuses, credits, as_of)

    def periods(self, company_id: str) -> list[tuple[int, int]]:
        return sorted({(l.year, l.quarter) for l in self.lines if l.company_id == company_id})

    def deposits_applied(self, company_id: str, group: str, year: int, quarter: int | None = None) -> Decimal:
        return sum((st.paid for st in self.statuses
                    if st.obligation.company_id == company_id and st.obligation.group == group
                    and st.obligation.year == year and (quarter is None or st.obligation.quarter == quarter)), ZERO)

    def form_941(self, company_id: str, year: int, quarter: int):
        return form_941(self.companies[company_id], self.liabilities, self.rules, year, quarter,
                        self.deposits_applied(company_id, "US-941", year, quarter), self.obligations)

    def form_940(self, company_id: str, year: int):
        return form_940(self.companies[company_id], self.liabilities, self.rules, year,
                        self.deposits_applied(company_id, "US-940", year))

    def liability_summary(self) -> dict[tuple, Decimal]:
        """(company, deposit group, tax code) -> total."""
        out: dict[tuple, Decimal] = defaultdict(lambda: ZERO)
        for l in self.liabilities:
            out[(l.company_id, l.deposit_group, l.tax_code)] += l.amount
        return dict(out)
