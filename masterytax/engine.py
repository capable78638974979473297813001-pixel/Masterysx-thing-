"""Liability engine: every computed cent carries a human-readable trace.

Statutory flat-rate taxes (Social Security, Medicare, FUTA, SUI, SDI ...) are
computed here with year-to-date wage bases tracked per employer. Income-tax
withholding (FIT/SIT) depends on W-4 elections the payroll system owns, so it is
taken as reported and only sanity-checked.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from .models import Company, Issue, Liability, PayLine
from .money import ZERO, clamp, fmt, r2
from .rules import RuleBook, TaxRule


def compute_liabilities(lines: list[PayLine], companies: dict[str, Company], rules: RuleBook) -> list[Liability]:
    ytd: dict[tuple, object] = defaultdict(lambda: ZERO)
    out: list[Liability] = []
    for line in sorted(lines, key=lambda l: (l.company_id, l.employee_id, l.pay_date, l.row)):
        company = companies[line.company_id]
        for tax in rules.applicable(line.work_state):
            out.append(_compute(tax, line, company, ytd))
    return out


def _compute(tax: TaxRule, line: PayLine, company: Company, ytd) -> Liability:
    v = tax.version_for(line.pay_date)
    exempt = sum((line.deductions.get(d, ZERO) for d in tax.exempt_deductions), ZERO)
    subject = line.gross - exempt
    key = (line.company_id, line.employee_id, line.year, tax.code)
    prior = ytd[key]
    ytd[key] = prior + subject
    exempt_note = f" (gross {fmt(line.gross)} less exempt {fmt(exempt)})" if exempt else ""

    if tax.kind == "withholding":
        amount = line.reported.get(tax.reported_column, ZERO)
        return _liab(line, tax, subject, subject, amount,
                     f"{tax.code}: {fmt(amount)} withheld as reported by payroll on subject wages {fmt(subject)}{exempt_note}")

    if tax.kind == "rate":
        if tax.rate_source == "company":
            rate = company.state_rate(tax.jurisdiction)
            rate_note = "company rate"
            if rate is None:
                rate, rate_note = tax.default_rate, "DEFAULT rate (no company rate on file)"
        else:
            rate, rate_note = v.rate, "statutory rate"
        base = v.wage_base
        before, after = clamp(prior, ZERO, base), clamp(prior + subject, ZERO, base)
        taxable = after - before
        amount = _cumulative(before, after, rate)
        base_note = f", wage base {fmt(base)} with {fmt(prior)} YTD before this check" if base is not None else ""
        trace = (f"{tax.code}: {rate * 100:.4g}% ({rate_note}) x taxable {fmt(taxable)} = {fmt(amount)}; "
                 f"subject {fmt(subject)}{exempt_note}{base_note} [rule eff. {v.effective}: {v.source}]")
        return _liab(line, tax, subject, taxable, amount, trace, rate)

    if tax.kind == "threshold":
        thr = v.threshold
        before, after = max(ZERO, prior - thr), max(ZERO, prior + subject - thr)
        taxable = after - before
        amount = _cumulative(before, after, v.rate)
        trace = (f"{tax.code}: {v.rate * 100:.4g}% x wages over {fmt(thr)} YTD = {fmt(taxable)} -> {fmt(amount)}; "
                 f"YTD before check {fmt(prior)} [rule eff. {v.effective}: {v.source}]")
        return _liab(line, tax, subject, taxable, amount, trace, v.rate)

    raise ValueError(f"unknown tax kind {tax.kind!r} for {tax.code}")


def _cumulative(before: Decimal, after: Decimal, rate: Decimal) -> Decimal:
    """Cumulative rounding: this check's tax is round(YTD after) - round(YTD before).

    Rounding never drifts, so an employee capped at the Social Security wage base
    has exactly round(base x rate) withheld for the year, not a cent more.
    """
    return r2(after * rate) - r2(before * rate)


def _liab(line, tax, subject, taxable, amount, trace, rate=None) -> Liability:
    return Liability(line, tax.code, tax.jurisdiction, tax.payer, tax.deposit_group, subject, taxable, amount, trace,
                     rate)


def period_total(liabilities: list[Liability]) -> Decimal:
    """Total owed for a filing period the way agencies compute it on the return.

    Employer contributions (SUI, ETT, FUTA) are figured as total taxable wages x
    rate, not as a sum of per-paycheck rounded amounts; everything else sums.
    """
    total = ZERO
    wages: dict[tuple, Decimal] = defaultdict(lambda: ZERO)
    for l in liabilities:
        if l.payer == "employer" and l.rate is not None and l.deposit_group != "US-941":
            wages[(l.tax_code, l.rate)] += l.taxable_wages
        else:
            total += l.amount
    return total + sum((r2(w * rate) for (_, rate), w in wages.items()), ZERO)


def reconcile_withholding(
    liabilities: list[Liability], companies: dict[str, Company], rules: RuleBook, tolerance=r2("0.01")
) -> list[Issue]:
    """Compare what payroll withheld with what the law requires, per paycheck.

    The employer owes the *required* employee FICA/SDI even when payroll
    under-withheld, so liabilities use the computed amount and every gap is
    surfaced here before anything is filed.
    """
    issues: list[Issue] = []
    by_line: dict[int, list[Liability]] = defaultdict(list)
    for liab in liabilities:
        by_line[id(liab.line)].append(liab)

    for group in by_line.values():
        line = group[0].line
        expected: dict[str, object] = defaultdict(lambda: ZERO)
        for liab in group:
            tax = rules.taxes[liab.tax_code]
            if tax.kind != "withholding" and tax.payer == "employee" and tax.reported_column:
                expected[tax.reported_column] += liab.amount
        for col, exp in expected.items():
            if col not in line.reported:
                continue
            diff = line.reported[col] - exp
            if abs(diff) > tolerance:
                direction = "over" if diff > 0 else "under"
                issues.append(Issue(
                    "warning", f"{direction}-withheld",
                    f"{line.pay_date} {col}: payroll withheld {fmt(line.reported[col])}, "
                    f"law requires {fmt(exp)} ({direction} by {fmt(abs(diff))})",
                    line.company_id, line.employee_id, line.row, line.source))

        for liab in group:
            tax = rules.taxes[liab.tax_code]
            if tax.kind == "withholding" and liab.amount == ZERO and liab.subject_wages > 0 and tax.jurisdiction != "US":
                issues.append(Issue(
                    "info", "no-sit-withheld",
                    f"{line.pay_date} no {tax.jurisdiction} income tax withheld on {fmt(liab.subject_wages)} (exempt employee?)",
                    line.company_id, line.employee_id, line.row, line.source))

    flagged = set()
    for liab in liabilities:
        tax = rules.taxes[liab.tax_code]
        key = (liab.company_id, tax.jurisdiction)
        if tax.rate_source == "company" and key not in flagged:
            if companies[liab.company_id].state_rate(tax.jurisdiction) is None:
                flagged.add(key)
                issues.append(Issue(
                    "warning", "default-sui-rate",
                    f"no {tax.jurisdiction} SUI rate on file; using default {tax.default_rate * 100:.4g}%",
                    liab.company_id))
    return issues
