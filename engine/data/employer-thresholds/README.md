# Employee-count thresholds: at what size does a rule turn on

Every other dataset in `data/` answers a question about a PAYCHECK: what tax
applies, what floor the hourly rate may not go below. This folder answers a
different question entirely: **at how many employees does an obligation an
employer didn't have yesterday start applying today?**

That question comes up constantly in practice ("do we have to do X now that
we've hired our 50th person?") and it is genuinely a *headcount* question, not
a wage or tax one -- unlike `data/minimum-wage/`'s employer-size TIERS (Hayward,
Seattle, Ohio's gross-receipts test), which change what NUMBER a jurisdiction
requires, these thresholds change WHETHER an entire separate law applies at
all: paid sick leave, mandatory notice before a layoff, health-insurance
mandates, anti-discrimination coverage. Crossing one of these lines doesn't
change a rate this engine computes -- it creates an obligation this engine
was never asked to compute in the first place.

## Scope, and what this deliberately is NOT

**This data is not wired into `calculate.ts` or any other calculation this
engine performs.** `calculatePaycheck()` answers "what does this paycheck look
like," and none of these thresholds change that number. This folder exists
purely as a sourced REFERENCE dataset -- the same research discipline as
`data/minimum-wage/` (a `sources` array with title/url/verifiedOn on every
claim, a disclosed `confidence` tier, and a `knownGaps` list saying what was
NOT verified), aimed at a different question than any other folder here
answers.

**Headcount itself is not always well-defined.** Every law below counts
differently: full-time equivalents, a snapshot on one day, an average over 20
weeks, "employed in New York State" vs. "on the payroll everywhere." A single
`employeeCount` number of the kind `minimumWage()` accepts is not enough to
answer most of these correctly, and this dataset does not pretend otherwise --
each threshold states its own counting rule in prose, the same way
`data/minimum-wage/`'s own README discloses that "only headcount TIERS are
machine-readable" for wage law; here, essentially none of it is, because the
questions are legal coverage tests, not arithmetic.

**Only New York's own state-level rules, plus the FEDERAL rules that apply to
any New York employer, are covered.** No other state's employee-count
thresholds are researched here. New York CITY has its own further layer
(NYC Human Rights Law's 4-employee floor, NYC's Fair Chance Act, etc.) that is
also out of scope for this first pass.

## Layout

```
NY-2026.json     Every employee-count-triggered NY state law obligation this
                 project could verify, plus the FEDERAL thresholds (ACA, FMLA,
                 COBRA, Title VII, ADEA, ADA, FLSA enterprise coverage) that
                 apply to a New York employer regardless of state law.
```

## Sourcing

Where a government agency's own page could be fetched and read directly, it
is marked `primary_source_confirmed`. Everything else rests on two or more
independent legal-compliance sources agreeing, marked `cross_source_confirmed`
-- several primary government PDFs (NY DOL's WARN fact sheet chief among them)
returned binary/unparseable content to the fetch tool used this session
despite being real, current, correctly-titled documents; where that happened,
it is disclosed in that entry's own `sources`, not silently papered over.

## Known gaps

- **NYC- and county-level thresholds are not covered.** Only NY STATE and
  federal law are researched here.
- **Which employees COUNT toward a threshold is its own legal question** for
  several of these laws (full-time vs. part-time, common ownership/"single
  employer" aggregation across affiliated companies, temp and leased workers)
  and is disclosed per-entry rather than modelled.
- **This is a snapshot, not a monitored feed.** Nothing here has a refresh
  cadence; treat the `asOf` date on the one file in this folder literally.
