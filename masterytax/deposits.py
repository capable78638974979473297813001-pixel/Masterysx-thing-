"""Deposit obligations, deposit matching, and late-deposit penalty exposure.

Federal 941 rules implemented (IRS Pub. 15, section 11):
  * lookback period: <= $50,000 -> monthly depositor, otherwise semiweekly;
    new employers (no lookback on file) start as monthly depositors
  * monthly: due the 15th of the following month
  * semiweekly: Wed-Fri paydays -> following Wednesday; Sat-Tue -> following
    Friday; always at least 3 business days after the semiweekly period ends,
    and periods are split at quarter end
  * $100,000 next-day rule, which also flips a monthly depositor to semiweekly
  * $2,500 de minimis: a quarter under $2,500 may be paid with the return
FUTA: deposit when the cumulative undeposited amount exceeds $500.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from .bizcal import add_business_days, next_business_day, quarter_of, quarter_return_due
from .engine import period_total
from .models import Company, Liability
from .money import ZERO, D, r2
from .rules import RuleBook

NEXT_DAY_THRESHOLD = D("100000")
DE_MINIMIS = D("2500")
LOOKBACK_LIMIT = D("50000")


@dataclass
class Obligation:
    company_id: str
    group: str
    year: int
    quarter: int
    period: str
    due: date
    amount: Decimal
    reason: str
    optional: bool = False
    first_liability: date | None = None


@dataclass
class ObligationStatus:
    obligation: Obligation
    applied: list = field(default_factory=list)  # [(deposit date, amount)]
    outstanding: Decimal = ZERO
    days_late: int = 0
    penalty: Decimal | None = None

    @property
    def paid(self) -> Decimal:
        return sum((a for _, a in self.applied), ZERO)

    @property
    def status(self) -> str:
        if self.outstanding > 0:
            return "optional-unpaid" if self.obligation.optional else ("overdue" if self.days_late else "open")
        return "late" if self.days_late else "paid"


def federal_schedule(company: Company) -> str:
    if company.federal_schedule:
        return company.federal_schedule
    if company.lookback_941_liability is None:
        return "monthly"
    return "monthly" if company.lookback_941_liability <= LOOKBACK_LIMIT else "semiweekly"


def semiweekly_period_end(d: date) -> date:
    wd = d.weekday()
    if wd in (2, 3, 4):  # Wed, Thu, Fri -> period ends Friday
        return d + timedelta(days=4 - wd)
    return d + timedelta(days=(1 - wd) % 7)  # Sat-Tue -> period ends Tuesday


def _period(schedule: str, day: date) -> tuple[tuple, str, date]:
    if schedule == "monthly":
        y, m = (day.year + 1, 1) if day.month == 12 else (day.year, day.month + 1)
        return ("M", day.year, day.month), f"{day:%Y-%m} (monthly)", next_business_day(date(y, m, 15))
    if schedule == "semiweekly":
        end = semiweekly_period_end(day)
        return (("S", end, day.year, quarter_of(day)), f"semiweekly through {end}"
                + (f" (Q{quarter_of(day)} portion)" if quarter_of(end) != quarter_of(day) else ""),
                add_business_days(end, 3))
    raise ValueError(f"unknown federal schedule {schedule!r}")


def _daily(liabs: list[Liability]) -> list[tuple[date, Decimal]]:
    days: dict[date, Decimal] = defaultdict(lambda: ZERO)
    for l in liabs:
        days[l.pay_date] += l.amount
    return sorted(days.items())


def build_obligations(liabilities: list[Liability], companies: dict[str, Company], rules: RuleBook) -> list[Obligation]:
    grouped: dict[tuple, list[Liability]] = defaultdict(list)
    for l in liabilities:
        grouped[(l.company_id, l.deposit_group, l.pay_date.year)].append(l)
    out: list[Obligation] = []
    for (cid, gcode, year), liabs in sorted(grouped.items()):
        group = rules.groups[gcode]
        company = companies[cid]
        if group.schedule == "federal_941":
            out += _federal_941(company, gcode, _daily(liabs), federal_schedule(company))
        elif group.schedule == "follows_federal":
            out += _periodic(cid, gcode, _daily(liabs), federal_schedule(company))
        elif group.schedule == "futa":
            out += _futa(cid, gcode, year, liabs, rules, group.threshold)
        elif group.schedule == "quarterly":
            out += _quarterly(cid, gcode, year, liabs)
        elif group.schedule == "accumulated_threshold":
            out += _accumulated(cid, gcode, _daily(liabs), group.threshold, group.business_days)
        else:
            raise ValueError(f"unknown deposit schedule {group.schedule!r}")
    return sorted(out, key=lambda o: (o.company_id, o.due, o.group))


def _federal_941(company: Company, gcode: str, daily, schedule: str) -> list[Obligation]:
    open_periods: dict[tuple, Obligation] = {}
    out: list[Obligation] = []
    triggered_quarters: set[tuple[int, int]] = set()
    for day, amt in daily:
        key, label, due = _period(schedule, day)
        ob = open_periods.get(key)
        if ob is None:
            ob = open_periods[key] = Obligation(company.id, gcode, day.year, quarter_of(day), label, due, ZERO,
                                                f"{schedule} depositor", first_liability=day)
        ob.amount += amt
        ob.first_liability = ob.first_liability or day
        if ob.amount >= NEXT_DAY_THRESHOLD:
            out.append(Obligation(company.id, gcode, day.year, quarter_of(day), f"{day} (next-day)",
                                  add_business_days(day, 1), ob.amount,
                                  "$100,000 next-day rule" + (" — now a semiweekly depositor" if schedule == "monthly" else ""),
                                  first_liability=ob.first_liability))
            triggered_quarters.add((day.year, quarter_of(day)))
            ob.amount = ZERO
            ob.first_liability = None
            schedule = "semiweekly"
    out += [o for o in open_periods.values() if o.amount != 0]

    totals: dict[tuple[int, int], Decimal] = defaultdict(lambda: ZERO)
    for day, amt in daily:
        totals[(day.year, quarter_of(day))] += amt
    for o in out:
        yq = (o.year, o.quarter)
        prev = (o.year, o.quarter - 1) if o.quarter > 1 else (o.year - 1, 4)
        small = totals[yq] < DE_MINIMIS or (prev in totals and totals[prev] < DE_MINIMIS)
        if small and yq not in triggered_quarters:
            o.optional = True
            o.reason += "; quarter qualifies for the $2,500 rule — may be paid with Form 941"
    return out


def _periodic(cid, gcode, daily, schedule) -> list[Obligation]:
    periods: dict[tuple, Obligation] = {}
    for day, amt in daily:
        key, label, due = _period(schedule, day)
        ob = periods.setdefault(key, Obligation(cid, gcode, day.year, quarter_of(day), label, due, ZERO,
                                                f"follows federal {schedule} schedule", first_liability=day))
        ob.amount += amt
    return [o for o in periods.values() if o.amount != 0]


def _quarterly(cid, gcode, year, liabs) -> list[Obligation]:
    by_q: dict[int, list[Liability]] = defaultdict(list)
    for l in liabs:
        by_q[quarter_of(l.pay_date)].append(l)
    totals = {q: period_total(ls) for q, ls in by_q.items()}
    return [Obligation(cid, gcode, year, q, f"{year} Q{q}", quarter_return_due(year, q), amt, "quarterly with return")
            for q, amt in sorted(totals.items()) if amt != 0]


def _accumulated(cid, gcode, daily, threshold, business_days) -> list[Obligation]:
    out, accum, start, current_q = [], ZERO, None, None
    for day, amt in daily:
        yq = (day.year, quarter_of(day))
        if current_q and yq != current_q and accum != 0:
            out.append(Obligation(cid, gcode, *current_q, f"{current_q[0]} Q{current_q[1]} remainder",
                                  quarter_return_due(*current_q), accum, "under threshold — due with quarterly return",
                                  first_liability=start))
            accum, start = ZERO, None
        current_q = yq
        accum += amt
        start = start or day
        if accum >= threshold:
            out.append(Obligation(cid, gcode, *yq, f"payroll {day}", add_business_days(day, business_days), accum,
                                  f"accumulated >= {threshold}: due within {business_days} business days",
                                  first_liability=start))
            accum, start = ZERO, None
    if current_q and accum != 0:
        out.append(Obligation(cid, gcode, *current_q, f"{current_q[0]} Q{current_q[1]} remainder",
                              quarter_return_due(*current_q), accum, "under threshold — due with quarterly return",
                              first_liability=start))
    return out


def futa_credit_reduction(liabs: list[Liability], rules: RuleBook, year: int) -> tuple[Decimal, dict[str, Decimal]]:
    by_state: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for l in liabs:
        if l.tax_code == "FED_FUTA" and l.pay_date.year == year:
            by_state[l.line.work_state] += l.taxable_wages
    detail = {st: r2(w * rules.futa_credit_reduction(year, st)) for st, w in by_state.items()}
    detail = {st: amt for st, amt in detail.items() if amt}
    return sum(detail.values(), ZERO), detail


def _futa(cid, gcode, year, liabs, rules, threshold) -> list[Obligation]:
    by_q: dict[int, list[Liability]] = defaultdict(list)
    for l in liabs:
        by_q[quarter_of(l.pay_date)].append(l)
    quarters: dict[int, Decimal] = defaultdict(lambda: ZERO, {q: period_total(ls) for q, ls in by_q.items()})
    cr, _ = futa_credit_reduction(liabs, rules, year)
    quarters[4] += cr
    out, carry = [], ZERO
    for q in (1, 2, 3, 4):
        carry += quarters[q]
        if q < 4 and carry > threshold:
            out.append(Obligation(cid, gcode, year, q, f"{year} Q{q}", quarter_return_due(year, q), carry,
                                  f"cumulative FUTA over ${threshold}"))
            carry = ZERO
        elif q == 4 and carry != 0:
            reason = "Q4 balance" + (f" incl. credit reduction {cr}" if cr else "")
            out.append(Obligation(cid, gcode, year, 4, f"{year} Q4", quarter_return_due(year, 4), carry, reason))
    return out


# ---------------------------------------------------------------- matching ---

def penalty_rate(days_late: int) -> Decimal:
    """IRC 6656 failure-to-deposit tiers (calendar days)."""
    if days_late <= 0:
        return ZERO
    if days_late <= 5:
        return D("0.02")
    if days_late <= 15:
        return D("0.05")
    return D("0.10")


def apply_deposits(obligations: list[Obligation], deposits: list[dict], rules: RuleBook, as_of: date):
    """FIFO-apply deposits to obligations (as designated under Rev. Proc. 2001-58).

    Returns (statuses, unapplied deposit credits).
    """
    statuses: list[ObligationStatus] = []
    credits: list[dict] = []
    keyed: dict[tuple, list[Obligation]] = defaultdict(list)
    for o in obligations:
        keyed[(o.company_id, o.group)].append(o)
    pools: dict[tuple, list[list]] = defaultdict(list)
    for d in sorted(deposits, key=lambda d: d["date"]):
        pools[(d["company_id"], d["deposit_group"])].append([d["date"], d["amount"], d.get("reference", "")])

    for key in sorted(set(keyed) | set(pools)):
        pool = pools.get(key, [])
        for ob in sorted(keyed.get(key, []), key=lambda o: o.due):
            st = ObligationStatus(ob)
            need = ob.amount
            penalty = ZERO
            group = rules.groups[ob.group]
            while need > 0 and pool:
                dep = pool[0]
                take = min(need, dep[1])
                st.applied.append((dep[0], take))
                late = max(0, (dep[0] - ob.due).days)
                st.days_late = max(st.days_late, late)
                penalty += r2(take * penalty_rate(late))
                need -= take
                dep[1] -= take
                if dep[1] <= 0:
                    pool.pop(0)
            st.outstanding = max(need, ZERO)
            if st.outstanding > 0 and as_of > ob.due and not ob.optional:
                late = (as_of - ob.due).days
                st.days_late = max(st.days_late, late)
                penalty += r2(st.outstanding * penalty_rate(late))
            if ob.optional:
                penalty = ZERO
            st.penalty = penalty if group.penalty == "irc6656" else None
            statuses.append(st)
        for dep in pool:
            if dep[1] > 0:
                credits.append({"company_id": key[0], "deposit_group": key[1], "date": dep[0],
                                "unapplied": dep[1], "reference": dep[2]})
    return statuses, credits
