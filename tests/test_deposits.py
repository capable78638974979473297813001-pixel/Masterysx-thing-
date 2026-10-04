import unittest
from datetime import date
from decimal import Decimal

from helpers import REMIT, company, line, liabilities
from masterytax.deposits import (apply_deposits, build_obligations, federal_schedule, penalty_rate,
                                 semiweekly_period_end)


def obligations(lines, co, group="US-941"):
    liabs = liabilities(lines, {"CO": co})
    return [o for o in build_obligations(liabs, {"CO": co}, REMIT) if o.group == group]


class ScheduleTest(unittest.TestCase):
    def test_lookback_determines_schedule(self):
        self.assertEqual(federal_schedule(company(lookback="50000")), "monthly")
        self.assertEqual(federal_schedule(company(lookback="50000.01")), "semiweekly")
        self.assertEqual(federal_schedule(company()), "monthly")  # new employer

    def test_semiweekly_periods(self):
        self.assertEqual(semiweekly_period_end(date(2026, 1, 7)), date(2026, 1, 9))  # Wed -> Fri
        self.assertEqual(semiweekly_period_end(date(2026, 1, 10)), date(2026, 1, 13))  # Sat -> Tue

    def test_semiweekly_due_dates(self):
        co = company(lookback="900000")
        fri = obligations([line("2026-01-09", "50000")], co)[0]
        self.assertEqual(fri.due, date(2026, 1, 14))  # following Wednesday
        mon = obligations([line("2026-01-12", "50000")], co)[0]
        self.assertEqual(mon.due, date(2026, 1, 16))  # following Friday
        holiday = obligations([line("2026-01-14", "50000")], co)[0]
        self.assertEqual(holiday.due, date(2026, 1, 22))  # MLK Monday adds a day

    def test_semiweekly_period_split_at_quarter_end(self):
        co = company(lookback="900000")
        # Sept 30 2026 is a Wednesday: the Wed-Fri period straddles Q3/Q4
        obs = obligations([line("2026-09-30", "50000"), line("2026-10-02", "50000", emp="E2", row=2)], co)
        self.assertEqual(sorted((o.quarter, o.due) for o in obs),
                         [(3, date(2026, 10, 7)), (4, date(2026, 10, 7))])

    def test_monthly_due_15th(self):
        obs = obligations([line("2026-01-09", "20000"), line("2026-01-23", "20000", row=2)], company())
        self.assertEqual(len(obs), 1)
        self.assertEqual(obs[0].due, date(2026, 2, 17))  # 15th is Sunday, 16th Presidents Day

    def test_100k_next_day_rule_flips_to_semiweekly(self):
        big = [line("2026-01-08", "500000", emp=f"E{i}", row=i) for i in range(5)]
        later = [line("2026-01-22", "10000", emp="E9", row=9)]
        obs = obligations(big + later, company(lookback="10000"))
        nextday = [o for o in obs if "next-day" in o.period]
        self.assertEqual(len(nextday), 1)
        self.assertEqual(nextday[0].due, date(2026, 1, 9))
        rest = [o for o in obs if o not in nextday]
        self.assertTrue(rest[0].period.startswith("semiweekly"))
        self.assertEqual(rest[0].due, date(2026, 1, 28))

    def test_de_minimis_quarter_is_optional(self):
        obs = obligations([line("2026-01-15", "3000")], company())
        self.assertTrue(all(o.optional for o in obs))

    def test_futa_carries_until_over_500(self):
        lines = [line("2026-01-15", "7000", emp=f"E{i}", row=i) for i in range(10)]  # 420 FUTA in Q1
        obs = obligations(lines, company(), "US-940")
        self.assertEqual([(o.quarter, o.amount, o.due) for o in obs], [(4, Decimal("420.00"), date(2027, 2, 1))])
        lines += [line("2026-05-15", "7000", emp=f"F{i}", row=20 + i) for i in range(5)]
        obs = obligations(lines, company(), "US-940")
        self.assertEqual([(o.quarter, o.amount) for o in obs], [(2, Decimal("630.00"))])

    def test_futa_credit_reduction_added_to_q4(self):
        obs = obligations([line("2025-02-01", "10000", state="CA")], company(), "US-940")
        self.assertEqual(obs[-1].amount, Decimal("126.00"))  # 7,000 x (0.6% + 1.2%)

    def test_ny_accumulated_threshold(self):
        lines = [line(f"2026-01-{d:02d}", "5000", state="NY", row=d, sit_withheld="300") for d in (9, 16, 23)]
        obs = obligations(lines, company(), "NY-WH")
        self.assertEqual([(o.amount, o.due) for o in obs][0], (Decimal("900"), date(2026, 1, 30)))


class StateScheduleTest(unittest.TestCase):
    def co(self, schedules):
        return company(accounts={"GA": {"sui_rate": "0.027"}}, schedules=schedules)

    def test_monthly_state_withholding_with_due_day(self):
        lines = [line("2026-01-16", "4000", state="GA", sit_withheld="150"),
                 line("2026-01-30", "4000", state="GA", row=2, sit_withheld="150")]
        obs = obligations(lines, self.co({"GA-WH": {"schedule": "monthly", "due_day": 15}}), "GA-WH")
        self.assertEqual([(o.amount, o.due) for o in obs], [(Decimal("300"), date(2026, 2, 17))])

    def test_semimonthly_periods(self):
        lines = [line("2026-01-09", "4000", state="GA", sit_withheld="100"),
                 line("2026-01-23", "4000", state="GA", row=2, sit_withheld="100")]
        obs = obligations(lines, self.co({"GA-WH": {"schedule": "semimonthly", "business_days": 3}}), "GA-WH")
        self.assertEqual([o.due for o in obs], [date(2026, 1, 21), date(2026, 2, 4)])  # MLK skipped

    def test_quarterly_ui_due_last_day_of_next_month(self):
        obs = obligations([line("2026-02-13", "4000", state="GA")], self.co({}), "GA-UI")
        self.assertEqual([(o.amount, o.due) for o in obs], [(Decimal("108.00"), date(2026, 4, 30))])


class PenaltyTest(unittest.TestCase):
    def test_tiers(self):
        self.assertEqual([penalty_rate(d) for d in (0, 1, 5, 6, 15, 16)],
                         [0, Decimal("0.02"), Decimal("0.02"), Decimal("0.05"), Decimal("0.05"), Decimal("0.10")])

    def test_fifo_matching_late_and_unpaid(self):
        co = company(lookback="900000")
        obs = obligations([line("2026-01-09", "50000"), line("2026-01-23", "50000", row=2)], co)
        amount = obs[0].amount
        deposits = [{"company_id": "CO", "deposit_group": "US-941", "date": date(2026, 1, 21), "amount": amount}]
        statuses, credits = apply_deposits(obs, deposits, as_of=date(2026, 2, 20))
        self.assertEqual(statuses[0].status, "late")
        self.assertEqual(statuses[0].days_late, 7)
        self.assertEqual(statuses[0].penalty, (amount * Decimal("0.05")).quantize(Decimal("0.01")))
        self.assertEqual(statuses[1].status, "overdue")
        self.assertEqual(statuses[1].penalty, (amount * Decimal("0.10")).quantize(Decimal("0.01")))
        self.assertEqual(credits, [])


if __name__ == "__main__":
    unittest.main()
