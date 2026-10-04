"""Banking calendar: federal holidays, business days and quarter helpers.

Holidays follow the Federal Reserve (EFTPS settlement) calendar: a holiday on
Sunday is observed Monday, a holiday on Saturday is *not* moved to Friday.
That is the conservative choice for deposit due dates — it never makes a due
date later than the IRS would.
"""

from __future__ import annotations

import calendar as _cal
from datetime import date, timedelta
from functools import lru_cache


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last = date(year, month, _cal.monthrange(year, month)[1])
    return last - timedelta(days=(last.weekday() - weekday) % 7)


@lru_cache(maxsize=None)
def federal_holidays(year: int) -> frozenset[date]:
    fixed = [date(year, 1, 1), date(year, 6, 19), date(year, 7, 4), date(year, 11, 11), date(year, 12, 25)]
    days = {d + timedelta(days=1) if d.weekday() == 6 else d for d in fixed}
    days |= {
        _nth_weekday(year, 1, 0, 3),  # Martin Luther King Jr. Day
        _nth_weekday(year, 2, 0, 3),  # Washington's Birthday
        _last_weekday(year, 5, 0),  # Memorial Day
        _nth_weekday(year, 9, 0, 1),  # Labor Day
        _nth_weekday(year, 10, 0, 2),  # Columbus Day
        _nth_weekday(year, 11, 3, 4),  # Thanksgiving
    }
    return frozenset(d for d in days if d.weekday() < 5)


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in federal_holidays(d.year)


def next_business_day(d: date) -> date:
    """d itself if it is a business day, otherwise the next one."""
    while not is_business_day(d):
        d += timedelta(days=1)
    return d


def add_business_days(d: date, n: int) -> date:
    while n > 0:
        d += timedelta(days=1)
        if is_business_day(d):
            n -= 1
    return d


def quarter_of(d: date) -> int:
    return (d.month - 1) // 3 + 1


def quarter_bounds(year: int, quarter: int) -> tuple[date, date]:
    start_month = 3 * (quarter - 1) + 1
    end_month = start_month + 2
    return date(year, start_month, 1), date(year, end_month, _cal.monthrange(year, end_month)[1])


def last_day_of_following_month(year: int, month: int) -> date:
    """Due-date convention for quarterly returns: e.g. Q1 (ends March) -> April 30."""
    y, m = (year + 1, 1) if month == 12 else (year, month + 1)
    return date(y, m, _cal.monthrange(y, m)[1])


def quarter_return_due(year: int, quarter: int) -> date:
    return next_business_day(last_day_of_following_month(year, quarter * 3))
