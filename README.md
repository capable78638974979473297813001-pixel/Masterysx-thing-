# MasteryTax

Open, explainable payroll tax compliance. It takes a payroll register and gives you liabilities, a deposit
calendar, penalty exposure, Form 941/940, W-2/W-3, state wage reports and 941-X/W-2c amendments.
Every number can be traced back to the rule that produced it.

MasteryTax is a from-scratch alternative to ADP's **MasterTax**. See [docs/research.md](docs/research.md) for
what MasterTax does, where users struggle with it, and what this project does differently.

```
$ python -m masterytax deposits --payroll examples/payroll_2026q1.csv --companies examples/companies.json \
      --deposits examples/deposits.csv --as-of 2026-04-15
ACME  US-941  semiweekly through 2026-02-06  2026-02-11  17,196.49  ...  late     3   343.93
ACME  US-941  semiweekly through 2026-03-20  2026-03-25  11,917.41  ...  overdue  21  1,191.74
```

## Why it's different from MasterTax

| | ADP MasterTax | MasteryTax |
|---|---|---|
| Calculation transparency | Proprietary | Every liability has a trace (`liabilities --explain EMP`) |
| Rate tables | Vendor-maintained, opaque | Effective-dated JSON with a source per value, reviewable in PRs |
| Payroll withholding | Trusts payroll's amounts | Recomputes statutory taxes and flags every variance |
| Rounding | — | Cumulative rounding: annual totals land exactly (no 1¢ over the SS max) |
| Late deposits | Shown after the fact | Matched to obligations, with §6656 penalty estimated before the IRS notice |
| Amendments | Keyed adjustments | Recomputed from corrected payroll, including wage-base side effects |
| Year-end | W-2 / 941 reconciliation | Same, plus per-employee SS over-max detection |
| Deployment | Hosted, enterprise sales | Runs offline, standard library only, open source |
| Coverage | 11,000+ jurisdictions, e-file & EFTPS transmission | Federal + CA, NY, TX, FL; no transmission yet (see roadmap) |

The last row matters: MasteryTax is not yet a replacement for agency e-filing. It's a transparent
engine and control layer that you can run alongside, or in front of, any filing channel.

## Quick start

Python 3.10+. There are no third-party dependencies.

```bash
python examples/generate_sample.py        # rebuild sample data (optional; already committed)
P="--payroll examples/payroll_2026q1.csv --companies examples/companies.json --deposits examples/deposits.csv --as-of 2026-04-15"

python -m masterytax validate     $P                       # import exceptions + withholding variances
python -m masterytax liabilities  $P [--explain A100]      # totals, or the full calculation trace
python -m masterytax deposits     $P                       # deposit calendar, matching, penalties
python -m masterytax 941          $P --year 2026 --quarter 1
python -m masterytax 940          $P --year 2026
python -m masterytax w2           $P --year 2026           # W-2s, W-3, W-2/941 reconciliation
python -m masterytax state        $P --state CA --year 2026 --quarter 1
python -m masterytax amend        $P --corrected examples/payroll_2026q1_corrected.csv --year 2026 --quarter 1
python -m masterytax report       $P --out report.html     # self-contained dashboard
python -m masterytax rules                                 # every rate, its effective date and source
```

Add `--json` to any command for machine-readable output. `validate` and `w2` exit non-zero when they find
errors, so you can use them as a CI gate before filing.

The sample data deliberately contains problems, and MasteryTax catches all of them: an invalid SSN (the row is
held, not processed), an executive whose payroll skipped Additional Medicare tax, Social Security withheld 1¢
over the annual maximum, a NY employer with no SUI rate on file, one federal deposit made 3 days late, and one
never made.

## Inputs

**Payroll register (CSV)**, one row per paycheck:

| column | required | notes |
|---|---|---|
| `company_id`, `employee_id`, `ssn`, `first_name`, `last_name` | yes | SSNs are validated (no 000/666/9xx area, 00 group, 0000 serial) |
| `pay_date`, `work_state`, `gross_wages` | yes | ISO dates; negative gross = reversal |
| `period_start`, `period_end` | no | used for 941 line 1 ("pay period including the 12th") |
| `pretax_401k`, `pretax_s125` | no | which taxes each one reduces is set per tax in the rules |
| `fit_withheld`, `ss_withheld`, `medicare_withheld`, `sit_withheld`, `sdi_withheld` | no | what payroll actually withheld; reconciled against the law |

**Companies (JSON):** FEIN, either `lookback_941_liability` (to derive the monthly/semiweekly schedule) or an explicit
`federal_schedule`, and `state_accounts` with account numbers and SUI experience rates.
See [examples/companies.json](examples/companies.json).

**Deposits (CSV):** `company_id, deposit_group, date, amount, reference`.

## How it works

```
payroll CSV ─► importer ─► engine ─────────► reconcile ─► exceptions
 (held rows)               (liabilities       (withheld vs required)
                            + traces)
                              │
                              ├─► deposits ─► obligations ─► match deposits ─► penalty exposure
                              └─► returns  ─► 941 / Sch B, 940 / Sch A, W-2/W-3, state, 941-X, W-2c
```

- `masterytax/data/rules.json` holds the tax rules (rate, wage base, threshold, deposit group, exempt
  deductions), each effective-dated with a source. Company-specific SUI rates live in the companies file.
- `engine.py` tracks year-to-date wages per employer. It handles wage bases, the Additional Medicare
  threshold and reversals, and uses cumulative rounding. FIT/SIT are taken as reported (they depend on W-4s the
  payroll system owns).
- `deposits.py` covers the lookback rule, monthly and semiweekly schedules (3-business-day minimum, periods
  split at quarter end), the $100,000 next-day rule (which also flips a monthly depositor to semiweekly), the
  $2,500 de minimis rule, FUTA's $500 carry-forward with credit reductions in Q4, and state schedules. It also
  covers FIFO deposit matching and the 2/5/10% failure-to-deposit tiers.
- `returns.py` builds the 941 with an automatic line 7 (fractions of cents), monthly line 16 or Schedule B,
  Schedule A on the 940, W-2/W-3 with W-2/941 reconciliation, state wage reports, and 941-X/W-2c.
- `bizcal.py` uses the Federal Reserve holiday calendar. Saturday holidays aren't moved to Friday, which is
  the conservative choice, because due dates are never later than the IRS's.

## Tests

```bash
python -m unittest discover -s tests
```

The tests cover the holiday calendar, wage bases, Additional Medicare, reversals, deduction treatment, SUI
rates, every deposit schedule including the $100k and de minimis rules, penalty tiers, the 941/940 line
math, W-3 reconciliation, amendments, import validation, and an end-to-end CLI run over the sample data.

## Roadmap

- More states and local taxes (PA EIT, OH municipalities, NYC/Yonkers), with SUI credit for out-of-state wages
- E-file outputs: EFTPS batch files, SSA EFW2 for W-2s, state ICESA/SUI formats
- Persistence (SQLite) and an HTTP API for multi-tenant service bureaus
- Agency notice tracking, and power-of-attorney / reporting-agent (Form 8655) workflows

## Disclaimer

The rates are researched and sourced, but tax rules change. Verify `rules.json` against each agency before
filing. MasteryTax doesn't give tax advice.
