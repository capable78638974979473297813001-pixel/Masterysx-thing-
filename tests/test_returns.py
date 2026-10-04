import csv
import tempfile
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path

from helpers import REMIT, company, line, liabilities, profile
from masterytax.engine import supported_states
from masterytax.importer import load_payroll
from masterytax.returns import (amend_941, form_940, form_941, state_wage_report, w2_records, w2c_records,
                               w3_reconcile)


class Form941Test(unittest.TestCase):
    def setUp(self):
        self.co = company()
        self.lines = [line("2026-01-15", "1000.01", emp=f"E{i}", row=i, fit_withheld="100") for i in range(7)]
        self.liabs = liabilities(self.lines, {"CO": self.co})

    def test_lines_tie_out(self):
        doc = form_941(self.co, self.liabs, 2026, 1, deposits=Decimal("500"))
        self.assertEqual(doc.value("2"), Decimal("7000.07"))
        self.assertEqual(doc.value("3"), Decimal("700"))
        self.assertEqual(doc.value("5a.2"), Decimal("868.01"))  # 7000.07 x 12.4%
        # per-employee rounding: 7 x (62.00 + 62.00) = 868.00 -> fractions-of-cents line absorbs it
        self.assertEqual(doc.value("5e") + doc.value("7"), sum(l.amount for l in self.liabs
                                                               if l.deposit_group == "US-941" and l.tax_code != "US_FIT"))
        self.assertEqual(doc.value("12"), doc.value("16.total"))
        self.assertEqual(doc.value("14"), doc.value("12") - Decimal("500"))

    def test_employee_count_uses_pay_period_including_12th(self):
        ln = [line("2026-03-20", "1000", emp="IN"), line("2026-03-05", "1000", emp="OUT", row=2)]
        ln = [l.__class__(**{**l.__dict__, "period_start": date(2026, 3, 8) if l.employee_id == "IN" else date(2026, 2, 20),
                             "period_end": date(2026, 3, 21) if l.employee_id == "IN" else date(2026, 3, 5)}) for l in ln]
        doc = form_941(self.co, liabilities(ln), 2026, 1)
        self.assertEqual(doc.value("1"), 1)


class Form940Test(unittest.TestCase):
    def test_940_lines(self):
        co = company()
        liabs = liabilities([line("2025-01-15", "10000", s125="1000", state="CA"),
                             line("2025-01-15", "5000", emp="E2", row=2, state="TX")], {"CO": co})
        doc = form_940(co, liabs, 2025)
        self.assertEqual(doc.value("3"), Decimal("15000"))
        self.assertEqual(doc.value("4"), Decimal("1000"))
        self.assertEqual(doc.value("5"), Decimal("2000"))
        self.assertEqual(doc.value("7"), Decimal("12000"))
        self.assertEqual(doc.value("8"), Decimal("72.00"))
        self.assertEqual(doc.value("11"), Decimal("84.00"))  # CA 7,000 x 1.2%
        self.assertEqual(doc.value("17"), doc.value("12"))
        self.assertEqual(doc.value("1b"), "CA, TX")


class YearEndTest(unittest.TestCase):
    def test_w3_reconciles_and_flags_excess_ss(self):
        co = company()
        lines = [line(f"2026-{m:02d}-15", "50000", row=m, ss_withheld="3100.00", fit_withheld="9000")
                 for m in range(1, 5)]
        w3, issues = w3_reconcile(co, liabilities(lines, {"CO": co}), 2026)
        self.assertEqual(w3["box3"], Decimal("184500"))
        self.assertIn("w2-ss-over-max", {i.code for i in issues})  # 4 x 3,100 = 12,400 > 11,439
        self.assertNotIn("w3-941-mismatch", {i.code for i in issues})

    def test_amendment_recomputes_wage_base_effects(self):
        co = company()
        orig = [line("2026-01-15", "180000"), line("2026-02-15", "1000", row=2)]
        corr = [line("2026-01-15", "180000"), line("2026-02-15", "10000", row=2)]
        x = amend_941(co, liabilities(orig), liabilities(corr), 2026, 1)
        self.assertEqual(x.value("8"), Decimal("3500"))  # only 3,500 more SS wages before the cap
        self.assertEqual(x.value("10"), Decimal("9000"))
        w2c = w2c_records(liabilities(orig), liabilities(corr), 2026, "CO")
        self.assertEqual(w2c[0]["changes"]["box3"]["correct"], Decimal("184500"))


class MultiStateTest(unittest.TestCase):
    def test_w2_state_local_and_box14(self):
        co = company(accounts={"NY": {"sui_rate": "0.03"}})
        nyc = profile(cert={"filingStatus": "single", "allowances": 1, "nycResident": True})
        rec = w2_records(liabilities([line("2026-01-16", "4000", state="NY", k401="200", s125="100")],
                                     {"CO": co}, [nyc]), 2026)[0]
        self.assertEqual(rec["box1"], Decimal("3700"))
        self.assertEqual(rec["box12"], {"D": Decimal("200")})
        self.assertEqual(rec["states"]["NY"]["box16"], Decimal("3700"))
        self.assertGreater(rec["states"]["NY"]["box17"], 0)
        nyc_local = next(v for k, v in rec["locals"].items() if "New York City" in k)
        self.assertEqual(nyc_local["box18"], Decimal("3700"))  # local wages = state wages for NYC
        self.assertEqual(set(rec["box14"]), {"NY PFL", "NY SDI"})

    def test_state_wage_report(self):
        co = company(accounts={"PA": {"account": "88-1", "sui_rate": "0.0365"}})
        lines = [line("2026-01-16", "6000", state="PA"), line("2026-02-13", "6000", state="PA", row=2)]
        doc = state_wage_report(co, liabilities(lines, {"CO": co}), REMIT, "PA", 2026, 1)
        self.assertEqual(doc.value("taxable"), Decimal("10000"))  # PA UI wage base
        self.assertEqual(doc.value("PA_SUI_ER"), Decimal("365.00"))
        self.assertIn("UC-2", doc.form)


class ImporterTest(unittest.TestCase):
    def test_bad_rows_are_held_not_fatal(self):
        rows = [
            {"company_id": "CO", "employee_id": "E1", "ssn": "512-34-1001", "first_name": "A", "last_name": "B",
             "pay_date": "2026-01-15", "work_state": "TX", "gross_wages": "1000"},
            {"company_id": "CO", "employee_id": "E2", "ssn": "900-12-3456", "first_name": "A", "last_name": "B",
             "pay_date": "2026-01-15", "work_state": "TX", "gross_wages": "1000"},
            {"company_id": "CO", "employee_id": "E3", "ssn": "512-34-1003", "first_name": "A", "last_name": "B",
             "pay_date": "01/15/2026", "work_state": "TX", "gross_wages": "1000"},
            {"company_id": "ZZ", "employee_id": "E4", "ssn": "512-34-1004", "first_name": "A", "last_name": "B",
             "pay_date": "2026-01-15", "work_state": "TX", "gross_wages": "1000"},
        ]
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "p.csv"
            with open(path, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=list(rows[0]))
                w.writeheader()
                w.writerows(rows)
            lines, issues = load_payroll(path, {"CO": company()}, supported_states())
        self.assertEqual([l.employee_id for l in lines], ["E1"])
        self.assertEqual({i.code for i in issues}, {"invalid-ssn", "bad-date", "unknown-company"})


if __name__ == "__main__":
    unittest.main()
