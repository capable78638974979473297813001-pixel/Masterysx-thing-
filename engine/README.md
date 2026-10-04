# Vendored tax engine

This directory is a copy of the `payroll-tax-engine` repository's calculation core. It covers
gross-to-net for federal, all 50 states + DC, and local taxes (AL, IN, KY, MI, OH, PA, NYC/Yonkers,
Portland, Seattle and others) for tax years 2025 and 2026, with effective-dated, sourced JSON rules.
MasteryTax uses it as the single source of tax math. MasteryTax's own Python layer only routes,
aggregates, files and reconciles what the engine computes.

| Path | From upstream | Role |
|---|---|---|
| `src/` | `src/` | Paycheck calculation (`calculatePaycheck`) |
| `data/` | `data/` | Rates, brackets, wage bases and local registries, with sources and known gaps |
| `payroll/ytd.ts`, `payroll/types.ts` | `payroll/` | The year-to-date ledger carried between paychecks |
| `tests/` | `tests/` | The engine's own suites that need only `src/` and `data/` |
| `bridge.ts` | (MasteryTax) | JSON stdin/stdout batch runner used by `masterytax/taxengine.py` |

Upstream commit: see `UPSTREAM`. Requires Node.js 22.6+ and no npm packages.

```bash
cd engine && node --test tests/*.test.ts
```

## Local patches

Each patch is marked in the file with a `$patchMasteryTax` key that explains the change.

1. **California cafeteria-plan and HSA treatment** (`data/states/CA-2025.json`, `CA-2026.json`), checked against
   EDD DE 231EB and DE 231TP (see `docs/verification.md`):
   - `stateDisabilityEmployee.exemptPretax`: upstream `[]` charged SDI on cafeteria-plan health/dependent-care
     deductions. It's now `section125, fsa, dependent_care, commuter`.
   - `suiEmployer.exemptPretax`: upstream used the engine default, which also excludes HSA. California taxes HSA
     contributions for UI/ETT, so it's now `section125, fsa, dependent_care, commuter`.
   - `exemptPretax` (PIT): `hsa` removed. California doesn't conform to the federal HSA exclusion
     (RTC 17131.4/17131.5).
2. **`tests/tax-year-2025.test.ts`**: removed the one test that exercised the upstream website's API validator
   (`site/lib/validate.ts`), which isn't part of the engine.

To re-sync, copy `src/`, `data/`, `payroll/ytd.ts` and `payroll/types.ts` from upstream. Then reapply the
patches above (search for `$patchMasteryTax`), update `UPSTREAM`, and run both test suites.
