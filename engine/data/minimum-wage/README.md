# Minimum wage database

Every federal, state, territorial and local minimum wage in the United States that
this project could verify, as of **2026-09-09**.

This is a different kind of dataset from everything else in `data/`. The rest of the
repo answers *what comes out of a paycheck*. These files answer the question that
constrains the paycheck before any withholding happens: **how low may the hourly rate
itself go.** A minimum wage is a floor on gross pay, not a tax — which is why it lives
in its own folder rather than being stapled onto the state tax rulesets.

## The one rule

DOL states it on its own State Minimum Wage Laws page: where federal, state and local
minimum wage laws all cover the same hour of work, the employer owes the **highest** of
the applicable rates.

So the data is stored one level at a time and merged at query time by
`minimumWage()` in `src/minimum-wage.ts`. Nothing here is pre-flattened into "the rate
for this address": a pre-merged table loses the reason a number is what it is, and goes
stale one jurisdiction at a time without anything noticing.

```ts
import { minimumWage } from './src/minimum-wage.ts';

minimumWage({ checkDate: '2026-08-15', state: 'WA', locality: 'seattle' });
// → { cents: 2130, bindingLevel: 'local', bindingJurisdiction: 'Seattle',
//     considered: [ federal 725, state 1713, local 2130 ] }
```

The `considered` trail always carries the levels that *lost*, so a caller can see why
an answer is what it is.

## Layout

```
federal-2026.json              the FLSA floor, the youth wage, and the federal
                               contractor minimum wages (EO 13658 / revoked EO 14026)
states/XX-2026.json            50 states + DC
territories/XX-2026.json       PR, VI, GU, AS, MP
local/XX-local-2026.json       69 city and county ordinances across 10 states
sectoral/XX-sectoral-2026.json minimum wages a state sets by INDUSTRY/OCCUPATION, not
                               geography -- California (fast food, health care, and the
                               LA/Santa Monica/Long Beach/Glendale/West Hollywood hotel
                               and airport ordinances) and New York (home care aides)
```

Every file carries its own `sources` (title, URL, `verifiedOn`, and a `verifiedBy` note
saying whether the figure was read from a primary page or cross-sourced), a
`confidence` tier, and a `knownGaps` list. Same discipline as the tax rulesets.

Each rate appears as **both** `hourly` (decimal dollars, what the jurisdiction
publishes) and `hourlyCents` (what this engine computes in). A test asserts the two can
never drift apart.

## What makes this hard, and where a naive table goes wrong

These are the traps the database is shaped around. Each one is a real, catchable error,
and each is covered by a test in `tests/minimum-wage.test.ts`.

**Not everything adjusts on January 1.** Alaska, DC, Oregon and the two Maryland
counties step on July 1; Florida steps on **September 30**; Santa Fe city and county
step on **March 1**; Chicago and Cook County step on July 1. A January-only refresh
cycle carries a stale rate for months of every year.

**Some jurisdictions step mid-year for *some* employers.** Renton and Everett WA and
Saint Paul MN each raise their smaller-employer tiers on July 1 while the large-employer
rate holds. Those tiers carry `effectiveFrom`/`effectiveTo` so a date query gets the
right one.

**A jurisdiction whose CURRENT rate took effect mid-2026 needs its PRIOR 2026 figure too,
or a January checkDate gets the wrong answer.** This project's data represents the world
as of its own `asOf` date — not a full year-round history — except where a rate stepped
after January 1 of its own year, which is common enough to be the rule rather than the
exception: Alaska, DC, Oregon (its state rate AND both named regions), Chicago, Cook
County, Montgomery and Howard Counties MD (across every one of their employer-size
tiers), and nine of California's ten July-cycle cities all changed on 2026-07-01, and
Malibu's own scheduled increase was suspended for a full extra year by its city council.
Each carries a `historicalPredecessorOf: 'standard' | 'tipped'` variant with its own
`effectiveFrom`/`effectiveTo` window, resolved by date the same way a size tier is
resolved by headcount. `minimumWage()` composes it correctly with every other axis: a
tipped query in a no-tip-credit state (California, Oregon) correctly gets the
PRIOR period's rate, not the current one; a named-region query (Oregon's Portland metro)
gets its OWN prior figure, not the state's generic one.

**"Surpassed by state law" is not the same as "delete the entry."** Albuquerque's
standard rate ($11.85) lost to New Mexico's $12.00, but its **tipped** minimum of $7.20
is more than double the state's $3.00 and still binds. Dropping the entry would underpay
every tipped worker in the state's largest city by $4.20 an hour.

**Tipped pay is a separate ladder, not a discount.** Nine jurisdictions here allow no tip
credit at all (Alaska, California, Minnesota, Montana, Nevada, Oregon, Washington, Guam,
and Flagstaff AZ). Three are on their own escalators: Chicago is abolishing its tip
credit by 2028, DC's is a rising percentage of the minimum wage under the amended
Initiative 82, and Michigan's rises a couple of points a year. Colorado is the only state
where a *locality* may widen the tip offset — Edgewater did, to $4.67.

**None of Washington's 8 local ordinances publish their own `tipped` figure — and that is
correct, not a gap.** Washington bans tip credits statewide, so a local ordinance with no
distinct tipped block still means the *full local rate* is the cash floor, not the state's
lower one. `minimumWage()` derives this from the state's own `tipCreditAllowed: false`
rather than requiring 8 duplicate blocks; a real bug this exact case caught during
development was the resolver falling back to the STATE's $17.13 for a tipped Seattle
query instead of Seattle's own $21.30. Two Maryland counties needed the opposite kind of
care: Montgomery County's tipped cash wage ($4.00) turned out to be genuinely different
from Maryland's own ($3.63) rather than derivable from it — `localStandard − stateCredit`
would have gotten it wrong — so it is researched and stated explicitly rather than
assumed. New Mexico's two under-researched counties needed both directions of the same
fix: Santa Fe County sets its own $4.62 (above the state's $3.00, so leaving it
unspecified would have *underpaid*), while Bernalillo County genuinely does just use the
state's $3.00 unchanged — confirmed and stated explicitly rather than left as a silent
gap that happens to produce the right number for the wrong reason.

**Two live state rates are below $7.25.** Montana's $4.00 and Oklahoma's $2.00 bind only
where the FLSA does not reach the employer at all. Both are carried as variants, never as
the standard rate. Georgia's and Wyoming's own $5.15 statutes are carried in a separate
`stateStatutoryRate` field for the same reason.

**American Samoa has no single minimum wage.** Federal law itself sets **18** industry
rates there, from $5.78 (garment manufacturing) to $7.19 (stevedoring), all below $7.25,
stepping $0.40 every three years. `minimumWage()` deliberately returns no state figure
for AS and says why, rather than inventing one.

**Two states split their STANDARD rate by named region, not by headcount.** New York
(downstate NYC/Nassau/Suffolk/Westchester vs. the rest of the state) and Oregon (Portland
metro vs. standard vs. non-urban) each carry their regional figures as ordinary
`variants` with no `appliesWhen` employer-size test — the wrong shape for the
`employeeCount`-driven tier selection every other state's variants use, and easy to miss
entirely if a caller assumes `employeeCount` is the only axis. `minimumWage()` exposes
a separate `region` query field for exactly this. New York layers a SECOND axis on top
for tipped pay — 'food_service' vs. 'service_employee' occupation, per region — and
upstate's food-service figure has no `variants` entry of its own at all: it *is* the
state's own baseline tipped rate. Getting that one case right (falling through to the
baseline rather than the region's only variant, which is the wrong occupation) is what
`resolveRegion()` in `src/minimum-wage.ts` exists to do.

**EO 14026 is revoked.** A payroll system still applying the $17.75 federal contractor
rate is overpaying; covered older contracts fell back to EO 13658's $13.65 (tipped
$9.55) on 2026-05-11.

**South Dakota publishes a half cent.** Its tipped cash wage is exactly half of $11.85 —
`$5.925`. DOL's federal table rounds it to $5.93; this database carries the state's own
figure, because rounding down would underpay. It is the only non-integer cent figure
here.

**Stale tier splits.** Maryland's small-employer tier, Minnesota's large/small split,
Nevada's health-benefits tier and Seattle's employer-size tiers have all been abolished
within the last two years. A table still carrying two rates for any of them is wrong.

## Sourcing

The spine is DOL's own three tables (state minimum wage laws, tipped employees, and the
consolidated table), all fetched and read directly. Every state or locality whose own
labor department, city page or official notice was also read directly is marked
`primary_source_confirmed`; anything resting on two or more independent secondary
sources agreeing is marked `cross_source_confirmed` and says so in `verifiedBy`.

Where the sources disagreed, the disagreement is recorded rather than smoothed over —
South Dakota's tipped cent, and Washington L&I's Burien and Renton figures correcting a
secondary source, are both documented in the files themselves.

Local coverage was canvassed against the UC Berkeley Labor Center's standing inventory of
US city and county minimum wage ordinances, so the list of *which jurisdictions exist* is
not this project's own guess. Repealed ordinances (Bangor ME, Tacoma WA) are deliberately
absent rather than carried at zero.

## Known gaps

- **Sector-specific ordinances.** California's fast food and health care rates, the Los
  Angeles hotel and airport worker rates, and the Santa Monica, Long Beach, Glendale and
  West Hollywood hotel ordinances are all carried in `sectoral/CA-sectoral-2026.json`, as
  is New York's home care aide minimum wage in `sectoral/NY-sectoral-2026.json`. The Los
  Angeles airport/hotel figures rest on secondary sources rather than the ordinance's own
  text, because every relevant city page and PDF returned HTTP 403 or 503 on direct fetch
  when this pass was done — see that file's own sources for which ones and why.
- **Coverage tests are not modelled.** Whether a particular employer is a "fast food
  restaurant," a covered health care facility, a Cook County municipality that opted out,
  or a SeaTac hospitality employer is a legal determination. This database carries rates,
  not coverage tests.
- **Only headcount tiers are machine-readable.** Ohio's gross-receipts threshold, New
  Jersey's seasonality test and unincorporated King County's revenue test are recorded in
  prose; `minimumWage()` says so in the trail rather than guessing.
- **State preemption of local ordinances was not individually researched.** The absence
  of a `local/` file for a state means no ordinance was found there, not that the state
  forbids one.
- **Nebraska's Omaha and Lincoln ordinances are in active litigation** and are carried as
  not in effect. Re-verify before relying on either.
- **Effective dates that fall just after this file's `asOf`** are carried in
  `scheduledChanges` rather than applied — most urgently Florida's step to $15.00 on
  2026-09-30, three weeks after this database was compiled.
