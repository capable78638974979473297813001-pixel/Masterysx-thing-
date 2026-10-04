import unittest
from datetime import date, timedelta
from decimal import Decimal

from helpers import REMIT, codes, company, line, liabilities, profile, run, total
from masterytax.bizcal import add_business_days, federal_holidays, next_business_day
from masterytax.engine import period_total


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


class FederalTest(unittest.TestCase):
    def test_social_security_caps_at_wage_base(self):
        lines = [line(date(2026, 1, 2) + timedelta(days=14 * i), "40000", row=i) for i in range(6)]
        liabs = liabilities(lines)
        self.assertEqual(total(liabs, "US_SS_EE", "taxable_wages"), Decimal("184500"))
        self.assertEqual(total(liabs, "US_SS_EE"), Decimal("11439.00"))
        self.assertEqual(total(liabs, "US_MED_EE", "taxable_wages"), Decimal("240000"))

    def test_wage_base_by_year(self):
        liabs = liabilities([line("2025-03-07", "200000"), line("2026-03-06", "200000", row=2)])
        by_year = {l.pay_date.year: l.taxable_wages for l in liabs if l.tax_code == "US_SS_ER"}
        self.assertEqual(by_year, {2025: Decimal("176100"), 2026: Decimal("184500")})

    def test_additional_medicare_only_over_200k(self):
        liabs = liabilities([line("2026-01-16", "150000"), line("2026-02-13", "100000", row=2)])
        self.assertEqual(total(liabs, "US_MED_ADDL", "taxable_wages"), Decimal("50000"))
        self.assertEqual(total(liabs, "US_MED_ADDL"), Decimal("450.00"))

    def test_section_125_and_401k_treatment(self):
        liabs = liabilities([line("2026-01-16", "5000", k401="500", s125="200")])
        self.assertEqual(total(liabs, "US_FIT", "taxable_wages"), Decimal("4300"))  # both excluded
        self.assertEqual(total(liabs, "US_SS_EE", "taxable_wages"), Decimal("4800"))  # 401k still FICA wages

    def test_reversal_is_held_not_netted(self):
        liabs, issues = run([line("2026-01-16", "5000"), line("2026-01-30", "-3000", row=2)])
        self.assertIn("reversal-held", codes(issues))
        self.assertEqual(total(liabs, "US_FUTA", "taxable_wages"), Decimal("5000"))

    def test_uncovered_year_is_refused(self):
        liabs, issues = run([line("2024-06-14", "1000")])
        self.assertEqual(liabs, [])
        self.assertIn("engine-refused", codes(issues))


class StateTest(unittest.TestCase):
    def test_california_ui_ett_and_sdi(self):
        cos = {"CO": company(accounts={"CA": {"sui_rate": "0.02"}})}
        liabs = liabilities([line("2026-01-16", "10000", state="CA", s125="1000")], cos)
        self.assertEqual(total(liabs, "CA_SUI_ER"), Decimal("140.00"))  # 7,000 x 2%
        self.assertEqual(total(liabs, "CA_ETT"), Decimal("7.00"))  # levy on UI wages
        self.assertEqual(total(liabs, "CA_DBL_EE"), Decimal("117.00"))  # 1.3% on 9,000: s125 excluded (patch)

    def test_california_hsa_is_taxed_for_ui_sdi_and_pit(self):
        # EDD DE 231EB / DE 231TP: HSA contributions are Subject to UI/ETT, SDI and PIT, cafeteria plan or not;
        # cafeteria health premiums are Not Subject to any of them; 401(k) is Subject to UI/SDI, not PIT.
        ln = line("2026-01-16", "5000", state="CA", s125="100", k401="300")
        ln.deductions["hsa"] = Decimal("200")
        liabs = liabilities([ln], {"CO": company(accounts={"CA": {"sui_rate": "0.03"}})})
        self.assertEqual(total(liabs, "CA_SUI_ER", "taxable_wages"), Decimal("4900"))
        self.assertEqual(total(liabs, "CA_DBL_EE", "taxable_wages"), Decimal("4900"))
        self.assertEqual(total(liabs, "US_FIT", "taxable_wages"), Decimal("4400"))  # federal excludes HSA
        hsa_only = line("2026-01-16", "5000", state="CA", emp="E2")
        hsa_only.deductions["hsa"] = Decimal("200")
        plain = line("2026-01-16", "5000", state="CA", emp="E3")
        sit = {l.line.employee_id: l.taxable_wages for l in liabilities([hsa_only, plain]) if l.tax_code == "CA_SIT"}
        self.assertEqual(sit["E2"], sit["E3"])  # HSA does not reduce California PIT wages

    def test_ny_2026_wage_base_default_rate_and_rsf(self):
        liabs, issues = run([line("2026-01-16", "30000", state="NY")], {"CO": company(accounts={"NY": {}})})
        self.assertEqual(total(liabs, "NY_SUI_ER", "taxable_wages"), Decimal("17600"))
        self.assertEqual(total(liabs, "NY_RSF"), Decimal("13.20"))
        self.assertIn("default-sui-rate", codes(issues))

    def test_unregistered_state_is_flagged(self):
        _, issues = run([line("2026-01-16", "3000", state="IL")])
        self.assertIn("not-registered", codes(issues))

    def test_pennsylvania_local_taxes_from_psd(self):
        prof = profile(cert={"workPSD": "700102", "residencePSD": "700102"})
        liabs = liabilities([line("2026-01-16", "2000", state="PA", freq="weekly")],
                            {"CO": company(accounts={"PA": {"sui_rate": "0.0365"}})}, [prof])
        self.assertEqual(total(liabs, "PA_EIT"), Decimal("60.00"))  # Pittsburgh resident 3%
        self.assertEqual(total(liabs, "PA_LST"), Decimal("1.00"))  # $52 / 52
        self.assertEqual({l.deposit_group for l in liabs if l.tax_code.startswith("PA_")},
                         {"PA-WH", "PA-UI", "PA-LOCAL"})

    def test_period_total_rounds_on_wages_not_checks(self):
        lines = [line("2026-01-16", "333.33", emp=f"E{i}", row=i) for i in range(3)]
        sui = [l for l in liabilities(lines, {"CO": company(accounts={"TX": {"sui_rate": "0.027"}})})
               if l.tax_code == "TX_SUI_ER"]
        self.assertEqual(period_total(sui), Decimal("27.00"))  # round(999.99 x 2.7%)


class RoutingTest(unittest.TestCase):
    def test_tax_lines_route_to_agencies(self):
        expect = {"US_FIT": "US-941", "US_MED_ADDL": "US-941", "US_FUTA": "US-940", "CA_SIT": "CA-WH",
                  "CA_DBL_EE": "CA-WH", "CA_SUI_ER": "CA-UI", "NY_NYC_SIT": "NY-WH", "NY_PFML_EE": "NY-CARRIER",
                  "NJ_UC_EE": "NJ-UI", "NJ_SIT": "NJ-WH", "WA_LTC_EE": "WA-LTC", "MA_PFML_ER": "MA-PFML",
                  "PA_EIT": "PA-LOCAL", "OH_SDIT": "OH-SD", "IN_COUNTY": "IN-WH", "OR_WBF_EE": "OR-WBF",
                  "US_RRTA_TIER1_EE": "US-CT1", "SEATTLE_PAYROLL_ER": "LOCAL-SEATTLE"}
        self.assertEqual({tid: REMIT.group_code(tid) for tid in expect}, expect)

    def test_unconfigured_state_withholding_is_conservative_and_flagged(self):
        g = REMIT.group("GA-WH")
        self.assertEqual((g.schedule, g.configured, g.agency), ("follows_federal", False, "Georgia Department of Revenue"))
        configured = REMIT.group("GA-WH", company(schedules={"GA-WH": {"schedule": "monthly", "due_day": 15}}))
        self.assertEqual((configured.schedule, configured.configured), ("monthly", True))
        self.assertTrue(REMIT.group("CA-WH").configured)


class ReconcileTest(unittest.TestCase):
    def test_under_withheld_social_security_is_flagged(self):
        _, issues = run([line("2026-01-16", "1000", ss_withheld="50.00", medicare_withheld="14.50")])
        under = [i for i in issues if i.code == "under-withheld"]
        self.assertEqual(len(under), 1)
        self.assertIn("12.00", under[0].message)

    def test_exact_withholding_is_clean(self):
        _, issues = run([line("2026-01-16", "1000", ss_withheld="62.00", medicare_withheld="14.50")])
        self.assertFalse({"under-withheld", "over-withheld"} & codes(issues))

    def test_fit_verified_only_with_w4_on_file(self):
        ln = line("2026-01-16", "3000", fit_withheld="100.00")
        _, without = run([ln])
        self.assertNotIn("under-withheld", codes(without))
        _, with_w4 = run([ln], profiles=[profile(extraWithholding=5000)])
        self.assertIn("under-withheld", codes(with_w4))

    def test_reported_withholding_is_the_liability(self):
        liabs = liabilities([line("2026-01-16", "3000", fit_withheld="123.45")])
        fit = next(l for l in liabs if l.tax_code == "US_FIT")
        self.assertEqual((fit.amount, fit.reported), (Decimal("123.45"), Decimal("123.45")))
        self.assertNotEqual(fit.computed, fit.amount)

    def test_missing_withholding_is_computed(self):
        liabs, issues = run([line("2026-01-16", "3000")])
        fit = next(l for l in liabs if l.tax_code == "US_FIT")
        self.assertEqual(fit.amount, fit.computed)
        self.assertIn("computed-withholding", codes(issues))

    def test_withholding_for_a_tax_that_does_not_apply(self):
        _, issues = run([line("2026-01-16", "3000", sdi_withheld="20.00")])
        self.assertIn("reported-tax-not-owed", codes(issues))

    def test_flat_local_tax_shortfall_is_exact(self):
        prof = profile(cert={"workPSD": "700102", "residencePSD": "700102"})
        _, issues = run([line("2026-01-16", "2000", state="PA", freq="weekly", local_withheld="60.00")],
                        {"CO": company(accounts={"PA": {}})}, [prof])
        self.assertIn("under-withheld", codes(issues))  # $1 LST missing, beyond rounding tolerance


if __name__ == "__main__":
    unittest.main()
