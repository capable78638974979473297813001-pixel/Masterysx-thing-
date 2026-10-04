import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from masterytax.cli import main

EX = Path(__file__).resolve().parent.parent / "examples"
BASE = ["--payroll", str(EX / "payroll_2026q1.csv"), "--companies", str(EX / "companies.json"),
        "--deposits", str(EX / "deposits.csv"), "--as-of", "2026-04-15"]


def run(*args) -> tuple[int, str]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = main([args[0], *BASE, *args[1:]])
    return code, buf.getvalue()


class SampleDataTest(unittest.TestCase):
    """The seeded problems in examples/ must all be caught."""

    def test_validate_catches_seeded_problems(self):
        code, out = run("validate")
        self.assertEqual(code, 1)
        for expected in ("invalid-ssn", "under-withheld", "default-sui-rate", "deposit-late", "deposit-overdue"):
            self.assertIn(expected, out)

    def test_returns_and_reports_render(self):
        for args in (("941", "--year", "2026", "--quarter", "1"), ("940", "--year", "2026"),
                     ("state", "--state", "CA", "--year", "2026", "--quarter", "1"),
                     ("amend", "--corrected", str(EX / "payroll_2026q1_corrected.csv"), "--year", "2026",
                      "--quarter", "1"), ("deposits",), ("liabilities", "--json")):
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


if __name__ == "__main__":
    unittest.main()
