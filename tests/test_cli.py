import contextlib
import csv
import io
import json
import tempfile
import unittest
from pathlib import Path

from masterytax.cli import main

EX = Path(__file__).resolve().parent.parent / "examples"
BASE = ["--payroll", str(EX / "payroll_2026q1.csv"), "--companies", str(EX / "companies.json"),
        "--employees", str(EX / "employees.json"), "--deposits", str(EX / "deposits.csv"), "--as-of", "2026-04-15"]


def run(*args) -> tuple[int, str]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = main([args[0], *BASE, *args[1:]])
    return code, buf.getvalue()


class SampleDataTest(unittest.TestCase):
    """The problems seeded in examples/ (see generate_sample.py) must all be caught."""

    @classmethod
    def setUpClass(cls):
        code, out = run("validate", "--json")
        cls.code, cls.issues = code, json.loads(out)

    def find(self, code, employee=None):
        return [i for i in self.issues if i["code"] == code and (employee is None or i.get("employee_id") == employee)]

    def test_validate_catches_seeded_problems(self):
        self.assertEqual(self.code, 1)
        self.assertEqual(len(self.find("invalid-ssn", "A105")), 6)
        self.assertTrue(self.find("under-withheld", "A102"))  # ignored W-4 extra withholding
        self.assertTrue(any("medicare" in i["message"] for i in self.find("under-withheld", "A100")))
        self.assertTrue(any("ss_withheld" in i["message"] for i in self.find("over-withheld", "A100")))
        self.assertTrue(self.find("under-withheld", "K301"))  # Pittsburgh LST never withheld
        self.assertTrue(self.find("default-sui-rate"))
        self.assertEqual(len(self.find("deposit-late")), 2)
        self.assertEqual(len(self.find("deposit-overdue")), 1)

    def test_clean_employees_raise_nothing(self):
        flagged = {i.get("employee_id") for i in self.issues if i.get("employee_id")}
        self.assertTrue(flagged.isdisjoint({"A101", "A103", "N200", "N201", "N202", "K300", "K302"}))

    def test_returns_and_reports_render(self):
        for args in (("941", "--year", "2026", "--quarter", "1"), ("940", "--year", "2026"),
                     ("state", "--state", "PA", "--year", "2026", "--quarter", "1"),
                     ("amend", "--corrected", str(EX / "payroll_2026q1_corrected.csv"), "--year", "2026",
                      "--quarter", "1"), ("deposits",), ("liabilities", "--json"), ("payments",)):
            code, out = run(*args)
            self.assertEqual(code, 0, args)
            self.assertTrue(out.strip(), args)
        self.assertIn("w2-ss-over-max", run("w2", "--year", "2026", "--json")[1])
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "r.html"
            self.assertEqual(run("report", "--out", str(path))[0], 0)
            html = path.read_text()
            self.assertIn("Deposit calendar", html)
            self.assertIn("Schedule B", html)

    def test_payment_instructions_never_claim_to_send(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "pay.csv"
            run("payments", "--csv", str(path))
            rows = list(csv.DictReader(io.StringIO(path.read_text())))
        self.assertTrue(rows)
        self.assertTrue(all(r["status"].startswith("NOT TRANSMITTED") for r in rows))
        overdue = [r for r in rows if r["deposit_group"] == "US-941"]
        self.assertEqual([(r["eftps_tax_type"], r["past_due"]) for r in overdue], [("94105", "True")])

    def test_coverage(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            main(["coverage", "--state", "PA"])
        self.assertIn("51 jurisdictions", buf.getvalue())
        self.assertIn("Pennsylvania", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
