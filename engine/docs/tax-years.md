# Tax years

Withholding is decided by the check date's year, never by the clock. A
correction or retroactive payment for an earlier year needs that year's
rules, so each year has its own files: `data/federal/<year>.json`,
`data/states/<ST>-<year>.json` and `data/local/*-<year>.json`.

## What each year covers

| Year | Federal | States | Local registries |
|---|---|---|---|
| 2026 | yes | all 50 + DC | AL, IN, KY, MI, OH (municipal, school district, JEDD), PA |
| 2025 | yes | all 50 + DC | the same set, each with its own 2025 file |

Every 2025 state file names its sources in `sources` (each with a
`verifiedOn` date and, where the source was read, the quoted passage) and
says in `$yearNote` how 2025 differs from 2026. Unemployment wage bases,
experience ranges and new-employer rates come from the U.S. Department of
Labor's *Significant Provisions of State UI Laws, January 2025* unless the
state's own notice is cited instead.

Where a state has no year-specific 2025 document online any more (it was
replaced at the same URL), the file says which substitute was used: an
Internet Archive copy of the original, the USDA National Finance Center's
transcription of the formula, or the state's unchanged statutory formula.
Each is disclosed in that file's `knownGaps`.

The 2025 federal file comes from IRS Publication 15-T (2025), SSA's $176,100
wage base, IRS Notice 2024-80 (deferral limits) and RRB Program Letter
2025-01. The 2025 tables were not revised after OBBBA passed in July 2025,
and the IRS told employers to keep using them, so they are what a 2025
cheque should have withheld.

## Changes during a year

A rule that changed part-way through a year is read by check date:

- `effectiveDated` in a state file: a list of `{from, set: {path: value},
  note}` overlays, applied in order to check dates on or after `from`
  (`src/registry.ts`, `applyEffectiveDated`). 2025 uses it for Idaho's
  May tables, Maryland's July formula, New Mexico's workers' comp fee,
  Virginia's July standard deduction and New Jersey's July new-employer
  rate.
- Method-specific switches: Utah's and Georgia's dated tables, Ohio's
  `midYearEffectiveDating` (July 2024 table until 2025-10-01, then the
  October 2025 table), and Alabama's `overtimeExemption` (overtime pay
  excluded through 2025-06-30; flag the earning `overtime: true`).
- Local registries: `rateHistory` on Alabama and Ohio municipalities and
  Ohio JEDDs, and `rateChanges` on Pennsylvania PSDs. Each picks the latest
  entry dated on or before the check date.

## What happens for a year that isn't fully covered

A paycheck is refused, not computed without its state tax:

- `calculatePaycheck()` throws `UnsupportedTaxYearError` when the federal
  rules, the work state or the residence state has no file for the year.
  2024 and earlier are not covered.
- The site API rejects the request at validation (422, field
  `workState.code` or `residenceState.code`) and names the year;
  `GET /api/states?year=2025` lists the states that year covers.

## Adding a year

Add `data/federal/<year>.json`, `data/states/<ST>-<year>.json` for every
state, and each `data/local/*-<year>.json` registry, with the same shape as
the latest year's files. The year gate picks them up with no code change.
Then run `npm run edge:build`.
