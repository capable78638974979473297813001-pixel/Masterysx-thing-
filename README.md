# MasteryTax

Open, explainable payroll tax compliance. It's an alternative to ADP's **MasterTax**, built on a sourced,
effective-dated tax engine that covers **federal, all 50 states + DC, and local taxes**. You give it a payroll
register. It gives you:

- every tax liability, each with a calculation trace
- payroll's withholding checked against W-4s and state/local certificates
- a deposit calendar for every agency, with deposits matched and penalty exposure estimated
- payment instructions
- Form 941/Schedule B, 940/Schedule A, W-2/W-3 with 941 reconciliation
- state quarterly wage reports
- 941-X/W-2c amendments
- a tax locator that turns addresses into local-tax codes

**It never moves money.** Payment output is instructions only, marked `NOT TRANSMITTED`.

See [docs/research.md](docs/research.md) for what MasterTax does and where this project differs.

## Quick start

You need Python 3.10+ and Node.js 22.6+. There are no packages to install.

```bash
P="--payroll examples/payroll_2026q1.csv --companies examples/companies.json \
   --employees examples/employees.json --deposits examples/deposits.csv --as-of 2026-04-15"

python -m masterytax validate     $P                     # import exceptions, withholding variances, late deposits
python -m masterytax liabilities  $P [--explain K300]    # totals, or every line's calculation trace
python -m masterytax deposits     $P                     # deposit calendar across all agencies + penalties
python -m masterytax payments     $P [--csv pay.csv]     # what to pay, to whom, by when (never transmitted)
python -m masterytax 941          $P --year 2026 --quarter 1
python -m masterytax 940          $P --year 2026
python -m masterytax w2           $P --year 2026         # W-2s (boxes 1-20), W-3, W-2/941 reconciliation
python -m masterytax state        $P --state PA --year 2026 --quarter 1
python -m masterytax amend        $P --corrected examples/payroll_2026q1_corrected.csv --year 2026 --quarter 1
python -m masterytax report       $P --out report.html   # self-contained dashboard
python -m masterytax locate       --employees examples/employees.json   # addresses -> local tax fields (network)
python -m masterytax coverage     [--state OH]           # years, jurisdictions, sources, known gaps
```

Add `--json` to any command for machine-readable output. `validate` and `w2` exit non-zero on errors, so they
can gate a filing run.

The sample data comes from [examples/generate_sample.py](examples/generate_sample.py). It covers three
employers (California; New York + Texas; Pennsylvania + Ohio with Pittsburgh and Columbus local taxes). The
payroll is correct except for deliberately seeded mistakes, and MasteryTax flags every one of them:

- an invalid SSN (those rows are held, not processed)
- an executive whose payroll skipped Additional Medicare tax and kept withholding Social Security past the
  wage base (the W-2 is also flagged over the maximum)
- an employee whose $50-per-check W-4 extra withholding was ignored
- a Pittsburgh employee whose $52 Local Services Tax was never withheld
- a New York employer with no SUI rate on file
- federal and New York deposits made late, and one federal deposit never made

## How it works

```
payroll CSV ─► importer ─► tax engine (Node) ─► liabilities + traces ─► routing ─► deposits ─► matching ─► penalties
 employees JSON (W-4s)      federal/51 states/locals    withheld vs. computed         (agency,     payment instructions
                                                                                        schedule,    returns, W-2s, amendments
                                                                                        return)
```

| Layer | Where | Job |
|---|---|---|
| Tax engine | [`engine/`](engine/README.md) (TypeScript, vendored from `payroll-tax-engine`) | One paycheck in, every tax line out: FIT (Pub 15-T), SIT for all states, SUI/SDI/PFML/LTC, local income taxes, with wage bases tracked across checks |
| Bridge | `masterytax/taxengine.py`, `engine/bridge.ts` | Runs a whole register through the engine in one batch, carrying year-to-date totals |
| Liabilities | `masterytax/engine.py` | Statutory taxes are owed as computed. Withholding is owed as payroll withheld it, and is verified when the W-4 is on file. Engine data-quality notices and refusals surface as exceptions |
| Routing | `masterytax/remittance.py`, `masterytax/data/agencies.json` | Every tax line maps to a deposit group (agency, schedule, return), overridable per company |
| Deposits | `masterytax/deposits.py` | Federal lookback, monthly/semiweekly, $100k next-day, $2,500 de minimis, FUTA $500 carry; state schedules (follows-federal, monthly by due day, semimonthly, quarterly, annual, NY's $700 accumulated rule); IRC §6656 penalty tiers |
| Filings | `masterytax/returns.py` | 941 with automatic line 7, 940 with credit reductions, W-2 boxes 1–20, W-3 reconciliation, state wage reports, 941-X/W-2c by recomputation |
| Payments | `masterytax/payments.py` | Payee, EFTPS tax type (94105, 09405 …), tax period, account, amount, initiate-by date. Never transmitted |

Withholding and statutory taxes are treated differently on purpose:

- **Statutory taxes** (FICA, FUTA, SUI, SDI, PFML, flat local taxes such as PA LST): the employer owes the
  engine's amount whatever payroll withheld, and any gap is flagged.
- **Income-tax withholding** (FIT, SIT, local income tax): owed as payroll actually withheld it. When the
  employee's W-4 and state certificate are in `employees.json`, it's checked against the engine within $1
  (whole-dollar rounding is allowed). When payroll reports no withholding at all, the engine's figure is used.

## Inputs

**Payroll register (CSV)**, one row per paycheck:

| Column | Required | Notes |
|---|---|---|
| `company_id`, `employee_id`, `ssn`, `first_name`, `last_name`, `pay_date`, `work_state`, `gross_wages` | yes | SSNs are validated; dates are ISO |
| `pay_frequency`, `period_start`, `period_end` | no | Frequency drives withholding; it's inferred from period dates if absent |
| `supplemental_wages` | no | The bonus/commission part of gross (flat supplemental rates) |
| `pretax_401k`, `pretax_403b`, `pretax_457`, `pretax_simple`, `pretax_s125`, `pretax_hsa`, `pretax_fsa`, `pretax_dependent_care`, `pretax_commuter` | no | Each tax applies its own exclusions |
| `fit_withheld`, `ss_withheld`, `medicare_withheld`, `sit_withheld`, `sdi_withheld`, `local_withheld` | no | What payroll withheld |
| any engine tax id, e.g. `NY_PFML_EE`, `PA_EIT`, `PA_LST` | no | What was withheld for exactly that tax; this beats the family columns above |
| `hours_worked` | no | For per-hour levies (Oregon WBF) |

Negative paychecks are held, never netted. Corrections go through `amend` with a corrected register, so wage
bases are recomputed.

**Companies (JSON)**: FEIN; `lookback_941_liability` or `federal_schedule`; `state_accounts`
(`account`, `sui_rate`, `ett_rate`, `reduced_wage_base`, `<kind>_account`); `deposit_schedules` per group
(`schedule`, `due_day`, `business_days`, `threshold`, `account`); and `round_withholding_to_whole_dollars`.

**Employees (JSON, optional)**: `federal_w4`, `work_state_certificate` (PSD codes, city, school district,
allowances …), `residence_state`, `pay_frequency`, and `address` (for `locate`). Field names follow the
engine's types; money is in cents.

**Deposits (CSV)**: `company_id, deposit_group, date, amount, reference`. The group codes (`US-941`, `CA-WH`,
`PA-LOCAL` …) are the ones `deposits` prints.

## Tests

```bash
python -m unittest discover -s tests       # 50 MasteryTax tests, including an end-to-end run over the sample data
(cd engine && node --test tests/*.test.ts)  # 1,120 engine tests (rates, worked examples from agency publications, geocoding)
```

## What is deliberately not here

- **Moving money.** No EFTPS enrollment, ACH origination or bank linking. `payments` produces instructions only.
- **Electronic filing.** Returns are computed data (every line, labelled) and are not transmitted. The SSA EFW2
  and IRS MeF formats are the next step. They should be built from the published specs, which this build
  environment couldn't reach.
- **State deposit schedules where the state assigns one.** These vary by employer. When a company hasn't set
  `deposit_schedules`, MasteryTax uses the federal schedule (never later than the state's) and warns.
- **Tax locator lookups** need network access to the Census geocoder and the agencies' boundary services.

## Disclaimer

The engine's rates come with sources, verification dates and disclosed known gaps (`coverage --state XX`), and
local patches are listed in [engine/README.md](engine/README.md). Facts checked against agency documents are
logged in [docs/verification.md](docs/verification.md). Verify before filing. MasteryTax doesn't give
tax advice.
