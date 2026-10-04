# Rounding & Precision Rules

**Status:** normative. This document is the spec; the code conforms to it, not the
other way around. Every calculation fixture is written to these rules, so
changing anything here invalidates fixtures and must be a deliberate, reviewed
act — not an accident discovered later against a customer's paycheck.

Written before Phase 2 so that "correct to the cent" has a single, unambiguous
meaning across federal, state, and local taxes.

---

## Why this document exists first

Rounding is global, it touches every tax, and retrofitting it invalidates every
test fixture. It is therefore the first decision made, before any calculation
code is trusted. A half-cent error is not a rounding nit in payroll — withheld
amounts must tie out to the penny against quarterly Form 941 deposits, and a
discrepancy surfaces months later as an unbalanced tax deposit.

---

## The seven rules

### 1. Money is integer cents. Never floating point.

The engine has no `Dollars` float type. Every monetary value is an integer
number of cents (`Cents = number`, always integral), from input through
intermediate arithmetic to output. See `src/money.ts`.

This is stronger than "use decimal arithmetic." There is no decimal money type
to mis-handle because there is no fractional money value at rest anywhere. The
classic `0.1 + 0.2 !== 0.3` defect cannot occur because `0.1` never exists as a
dollar amount — it is `10` cents.

The only place a non-integer appears is *inside* a single rate multiplication
(`base_cents * rate`), and it is rounded back to an integer before it is stored
in any variable or returned. It never accumulates.

### 2. Round only at the point each tax is emitted.

Rounding happens at exactly one place per tax: when that tax's dollar amount is
produced from its base and rate (`applyRate` in `src/money.ts`). Nowhere else.

Concretely: annualization, bracket-excess subtraction, and the base-tax addition
are all exact integer operations. The de-annualization divide
(`tentative_annual / periods`) is the one federal-income-tax exception — it is
rounded at that step because Pub 15-T defines the per-period tentative amount as
a rounded figure (see rule 6).

### 3. Round half away from zero (half-up on the cent).

`applyRate` rounds a `.5` cent up in magnitude: `+X.5 → +(X+1)`, `-X.5 →
-(X+1)`. This is what the IRS and every state agency assume in their published
worked examples. Banker's rounding (half-to-even) would drift against those
examples and produce cent-level disagreements that read as bugs to the customer.

### 4. Each tax is rounded independently.

Every tax line is computed and rounded from its own base. No tax is ever derived
by subtracting a rounded subtotal from a rounded total. Social Security,
Medicare, federal income tax, and each state/local tax each round their own
result. This guarantees that a per-tax breakdown always sums to the reported
totals and that no rounding error is smeared from one tax into another.

### 5. Annualization and de-annualization intermediates are not pre-rounded.

The annualize → bracket → de-annualize pipeline keeps full integer precision
through the annual figures. Wages are annualized by exact multiplication;
bracket tax is computed exactly on the annual amount; only the final
divide-back-to-period step rounds (rule 6). We never round the annualized wage
or the annual tentative tax to whole dollars mid-pipeline.

### 6. The federal per-period divide rounds to the cent.

`tentative_per_period = round(tentative_annual_cents / periods_per_year)`,
half-up. Pub 15-T Worksheet 1A treats the per-pay-period withholding as a
rounded amount, and the credit-per-period divide (Step 3) rounds the same way.
Both are the deliberate, named rounding boundaries for federal income tax.

### 7. Whole-dollar rounding is optional, last, and per-line.

The IRS permits rounding withheld income tax to whole dollars. When a caller
requests it (`roundToWholeDollars`), it is applied **after** all cent-level
computation, independently to each already-computed tax line, as the final step
(`calculate.ts`). It is never the default and never applied to FICA.

---

## Wage-base caps and mid-payment splits

A capped tax (Social Security, FUTA, SUTA) does not apply all-or-nothing when a
single payment crosses the wage base. The taxable portion is
`min(current_wages, max(0, cap - ytd_wages))` (`underCap` in `src/money.ts`),
and the tax rounds on that portion. A bonus that pushes an employee over the
Social Security wage base is taxed on the dollars below the cap and exempt on the
dollars above it, within the same check. This is the first fixture written for
Phase 2 because it is both common and the likeliest place to diverge from a
customer's incumbent system.

Additional Medicare mirrors this on the other side of a threshold
(`overThreshold`): only the portion of the payment above $200,000 YTD is
surtaxed.

---

## What "correct" means, operationally

Publication 15-T is not always explicit about rounding order, and where it is
silent we do **not** resolve it by argument. The tie-breaker is the customer's
real paychecks (Phase 3): their incumbent engine's output is the de facto spec,
because a discrepancy against the system they already run is a support ticket no
matter which number is more technically defensible. Any ambiguity these rules
don't settle gets settled by matching those paychecks to the cent, and the
resolution is recorded here.

---

## Change log

| Date | Change | Fixtures reviewed |
|------|--------|-------------------|
| 2026-08-11 | Initial rules extracted from `src/money.ts` and `src/taxes/federal.ts`. | 54 existing tests already conform. |
