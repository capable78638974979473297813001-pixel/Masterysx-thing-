import unittest
from datetime import date, timedelta
from decimal import Decimal

from helpers import RULES, company, line, liabilities, total
from masterytax.bizcal import add_business_days, federal_holidays, next_business_day
from masterytax.engine import period_total, reconcile_withholding


class CalendarTest(unittest.TestCase):
    def test_2026_holidays(self):
        h = federal_holidays(2026)
        self.assertIn(date(2026, 1, 19), h)  # MLK
        self.assertIn(date(2026, 2, 16), h)  # Presidents Day
        self.assertIn(date(2026, 11, 26), h)  # Thanksgiving
        self.assertNotIn(date(2026, 7, 3), h)  # July 4 is a Saturday: banks do not observe Friday
        self.assertIn(date(2027, 7, 5), federal_holidays(2027))  # July 4 2027 is a Sunday -> Monday

    def test_business_day_math(self):
        self.assertEqual(next_business_day(date(2026, 2, 15)), date(2026, 2, 17))  # Sun, then holiday Mon
        self.assertEqual(add_business_days(date(2026, 1, 16), 3), date(2026, 1, 22))  # skips MLK


class WageBaseTest(unittest.TestCase):
    def test_social_security_caps_at_wage_base_exactly(self):
        lines = [line(date(2026, 1, 2) + timedelta(days=14 * i), "40000", row=i) for i in range(6)]
        liabs = liabilities(lines)
        self.assertEqual(total(liabs, "FED_SS_EE", "taxable_wages"), Decimal("184500"))
        self.assertEqual(total(liabs, "FED_SS_EE"), Decimal("11439.00"))  # cumulative rounding: no stray cent
        self.assertEqual(total(liabs, "FED_MED_EE", "taxable_wages"), Decimal("240000"))

    def test_wage_base_by_year(self):
        liabs = liabilities([line("2025-03-01", "200000"), line("2026-03-01", "200000", row=2)])
        by_year = {l.pay_date.year: l.taxable_wages for l in liabs if l.tax_code == "FED_SS_ER"}
        self.assertEqual(by_year, {2025: Decimal("176100"), 2026: Decimal("184500")})

    def test_additional_medicare_only_over_200k(self):
        liabs = liabilities([line("2026-01-15", "150000"), line("2026-02-15", "100000", row=2)])
        self.assertEqual(total(liabs, "FED_ADDL_MED", "taxable_wages"), Decimal("50000"))
        self.assertEqual(total(liabs, "FED_ADDL_MED"), Decimal("450.00"))

    def test_reversal_gives_back_taxable_wages(self):
        liabs = liabilities([line("2026-01-15", "5000"), line("2026-01-20", "-3000", row=2)])
        self.assertEqual(total(liabs, "FED_FUTA", "taxable_wages"), Decimal("2000"))

    def test_section_125_and_401k_treatment(self):
        liabs = liabilities([line("2026-01-15", "5000", k401="500", s125="200")])
        self.assertEqual(total(liabs, "FED_FIT", "subject_wages"), Decimal("4300"))  # both excluded
        self.assertEqual(total(liabs, "FED_SS_EE", "subject_wages"), Decimal("4800"))  # 401k still FICA wages


class StateTest(unittest.TestCase):
    def test_company_sui_rate_and_default(self):
        cos = {"CO": company(accounts={"CA": {"sui_rate": "0.02"}})}
        liabs = liabilities([line("2026-01-15", "10000", state="CA")], cos)
        self.assertEqual(total(liabs, "CA_SUI"), Decimal("140.00"))  # 7,000 x 2%
        self.assertEqual(total(liabs, "CA_ETT"), Decimal("7.00"))
        self.assertEqual(total(liabs, "CA_SDI"), Decimal("130.00"))  # 1.3%, no cap in 2026
        issues = reconcile_withholding(liabilities([line("2026-01-15", "100", state="NY")]), {"CO": company()}, RULES)
        self.assertIn("default-sui-rate", {i.code for i in issues})

    def test_ny_2026_wage_base(self):
        liabs = liabilities([line("2026-01-15", "30000", state="NY")])
        self.assertEqual(total(liabs, "NY_SUI", "taxable_wages"), Decimal("17600"))

    def test_period_total_rounds_on_wages_not_checks(self):
        lines = [line("2026-01-15", "333.33", emp=f"E{i}", row=i) for i in range(3)]
        cos = {"CO": company(accounts={"TX": {"sui_rate": "0.027"}})}
        sui = [l for l in liabilities(lines, cos) if l.tax_code == "TX_SUI"]
        self.assertEqual(sum(l.amount for l in sui), Decimal("27.00"))  # 3 x 9.00 per check
        self.assertEqual(period_total(sui), Decimal("27.00"))  # round(999.99 x 2.7%) = 27.00


class ReconcileTest(unittest.TestCase):
    def test_under_withheld_social_security_is_flagged(self):
        liabs = liabilities([line("2026-01-15", "1000", ss_withheld="50.00", medicare_withheld="14.50")])
        codes = {i.code: i for i in reconcile_withholding(liabs, {"CO": company()}, RULES)}
        self.assertIn("under-withheld", codes)
        self.assertIn("12.00", codes["under-withheld"].message)

    def test_exact_withholding_is_clean(self):
        liabs = liabilities([line("2026-01-15", "1000", ss_withheld="62.00", medicare_withheld="14.50")])
        self.assertEqual([i for i in reconcile_withholding(liabs, {"CO": company()}, RULES)
                          if i.code.endswith("withheld")], [])


if __name__ == "__main__":
    unittest.main()
