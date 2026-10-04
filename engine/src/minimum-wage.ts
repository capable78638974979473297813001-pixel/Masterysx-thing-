import type { Cents } from './money.ts';
import {
  federalMinimumWageRuleset,
  localMinimumWageRuleset,
  stateMinimumWageRuleset,
  hasStateMinimumWageRuleset,
  type MinimumWageAmount,
  type MinimumWageJurisdiction,
  type TippedMinimumWage,
} from './registry.ts';
import { resolveCertBoolean } from './validate.ts';

/**
 * The minimum wage side of this engine.
 *
 * Everything else in src/ answers "what comes OUT of a paycheck." This
 * module answers the one question that constrains the paycheck before any
 * of that happens: how low may the hourly rate itself go.
 *
 * The whole calculation is one rule, and it is DOL's own: where federal,
 * state and local minimum wage laws all cover the same hour of work, the
 * employer owes the HIGHEST of them. That is why the data is stored one
 * level at a time in data/minimum-wage/ and merged here at query time,
 * rather than pre-flattened into a single rate per address — a pre-merged
 * table silently loses the reason a number is what it is, and goes stale
 * one jurisdiction at a time without anything noticing.
 *
 * Two consequences worth stating plainly, because they are where naive
 * implementations go wrong:
 *
 *  - TIPPED pay is a separate ladder, not a discount on this one. Where a
 *    jurisdiction allows a tip credit, its floor is a CASH wage; where it
 *    does not (California, Minnesota, Montana, Nevada, Oregon, Washington,
 *    Alaska, Guam, and Flagstaff AZ), the full rate is owed in cash. The
 *    highest-applicable rule applies to the cash floors independently, so
 *    a tipped answer is never derived from the standard answer.
 *
 *  - EMPLOYER SIZE genuinely changes the answer in a dozen jurisdictions,
 *    and the size tiers are not all the same shape (headcount in Burien,
 *    headcount-or-revenue in unincorporated King County, gross receipts in
 *    Ohio, seasonality in New Jersey). Only the headcount tiers are
 *    machine-readable; where a tier is not, this module says so in the
 *    trail instead of guessing at it.
 */

export type MinimumWageLevel = 'federal' | 'state' | 'local';

export interface MinimumWageQuery {
  /** Any date; selects the year's ruleset the same way every other loader here does. */
  checkDate: string;
  /** Two-letter state, DC, or territory code. */
  state: string;
  /**
   * A local jurisdiction id or name from data/minimum-wage/local/, e.g.
   * 'seattle' or 'Los Angeles County (unincorporated areas only)'. Omit it
   * and no local ordinance is applied — this engine will not guess a
   * locality from a state code.
   */
  locality?: string;
  /** Employer headcount, used only where a jurisdiction publishes a headcount tier. */
  employeeCount?: number;
  /** Ask for the tipped CASH floor rather than the standard rate. */
  tipped?: boolean;
  /**
   * A state's own named geographic sub-region, from its ruleset's own
   * `variants[].id` — e.g. 'downstate' for New York (NYC, Nassau, Suffolk,
   * Westchester) or 'portland_metro' / 'nonurban' for Oregon. Omit it and
   * the state's baseline figure applies — this engine will not guess which
   * region an employee works in from a bare two-letter state code, the same
   * discipline as `locality`.
   */
  region?: string;
  /**
   * New York alone splits TIPPED employees into two differently-credited
   * occupation categories per region — 'food_service' (restaurant workers)
   * and 'service_employee' (hotel/other hospitality). Meaningful only when
   * `tipped` is true and `region` names a New-York-shaped state. Omitted
   * with an ambiguous region, this defaults to 'food_service' — the larger
   * category — and the answer's trail says so rather than guessing silently.
   */
  occupation?: 'food_service' | 'service_employee';
}

export interface MinimumWageCandidate {
  level: MinimumWageLevel;
  jurisdiction: string;
  /** Undefined where a jurisdiction publishes no applicable figure (e.g. an employer its ordinance does not reach). */
  cents?: Cents;
  basis: string;
  /** Set where this level's figure could not be narrowed with the inputs given. */
  caveat?: string;
}

export interface MinimumWageAnswer {
  /** The binding floor, in cents per hour. */
  cents: Cents;
  hourly: number;
  /** Which level actually binds — the highest of those considered. */
  bindingLevel: MinimumWageLevel;
  bindingJurisdiction: string;
  /** Whether `cents` is a cash floor that tips may top up, or the full rate. */
  tipCreditAllowed: boolean;
  /** Every level considered, in federal → state → local order, including the ones that lost. */
  considered: MinimumWageCandidate[];
}

/** Cents can carry a half-cent in exactly one place: South Dakota's $5.925 tipped wage. */
function toCents(amount: { hourlyCents: number }): number {
  return amount.hourlyCents;
}

function tippedCents(tipped: TippedMinimumWage | undefined): number | undefined {
  return tipped ? tipped.cashWageCents : undefined;
}

function sizeMatches(amount: MinimumWageAmount, employeeCount: number | undefined): boolean {
  const when = amount.appliesWhen;
  if (!when) return false;
  // NaN must be treated as "not supplied," never as "matches everything."
  // `NaN < x` and `NaN > x` are BOTH false in JS, so without this guard a
  // NaN employeeCount (e.g. from Number(someInvalidInput) upstream) would
  // silently satisfy every size bound and resolve to whichever tier
  // happens to be first in the variants array — a wrong, arbitrary answer
  // rather than an honest fallback to the headline rate.
  if (employeeCount === undefined || Number.isNaN(employeeCount)) return false;
  if (when.employeeCountMin !== undefined && employeeCount < when.employeeCountMin) return false;
  if (when.employeeCountMax !== undefined && employeeCount > when.employeeCountMax) return false;
  return true;
}

function dateInRange(amount: MinimumWageAmount, checkDate: string): boolean {
  if (amount.effectiveFrom && checkDate < amount.effectiveFrom) return false;
  if (amount.effectiveTo && checkDate > amount.effectiveTo) return false;
  return true;
}

/** Whether a jurisdiction has ANY named-region structure at all — New York and Oregon, currently. */
function hasRegions(variants: MinimumWageAmount[] | undefined): boolean {
  return (variants ?? []).some((v) => v.regionalOverrideOf !== undefined);
}

/**
 * The rate that was in effect before the current headline figure took over
 * mid-year, if `checkDate` falls in its window — see
 * MinimumWageAmount.historicalPredecessorOf's own doc comment for why this
 * exists at all (this project's data is a point-in-time snapshot, not a
 * full year-round history, EXCEPT where a jurisdiction's current rate took
 * effect after January 1 of its own year, which is common: Alaska, DC and
 * Oregon all step on July 1).
 */
function historicalPredecessor(
  variants: MinimumWageAmount[] | undefined,
  kind: 'standard' | 'tipped',
  checkDate: string,
): MinimumWageAmount | undefined {
  return (variants ?? []).find(
    (v) => v.historicalPredecessorOf === kind && dateInRange(v, checkDate),
  );
}

interface ScheduledWageChange {
  hourlyCents?: number;
  tippedCashWageCents?: number;
  effectiveDate?: string;
  effectiveTo?: string;
}

/**
 * The next legislated step after the headline figure, once checkDate has
 * reached it. Florida's September 30 step lives here rather than as a
 * variant. A historical predecessor, when one covers checkDate, wins
 * instead — that window is already a complete rate.
 */
function applicableScheduledChange(
  source: { scheduledChanges?: unknown },
  checkDate: string,
): ScheduledWageChange | undefined {
  const changes = source.scheduledChanges;
  if (!Array.isArray(changes)) return undefined;
  const applicable = (changes as ScheduledWageChange[])
    .filter(
      (c) =>
        typeof c.effectiveDate === 'string' &&
        checkDate >= c.effectiveDate &&
        (!c.effectiveTo || checkDate <= c.effectiveTo),
    )
    .sort((a, b) => (b.effectiveDate ?? '').localeCompare(a.effectiveDate ?? ''));
  return applicable[0];
}

function withScheduledStandard(
  base: MinimumWageAmount,
  source: { scheduledChanges?: unknown },
  checkDate: string,
): MinimumWageAmount {
  const change = applicableScheduledChange(source, checkDate);
  if (change?.hourlyCents == null) return base;
  return { ...base, hourlyCents: change.hourlyCents, hourly: change.hourlyCents / 100 };
}

/**
 * Resolve a named region (MinimumWageQuery.region) against a jurisdiction's
 * variants, for either the standard rate or the tipped rate.
 *
 * Standard-rate regions are looked up by variant id (New York's 'downstate',
 * Oregon's 'portland_metro'/'nonurban') — each fully replaces the baseline
 * figure. Tipped-rate regions add a second axis, occupation, because New
 * York alone splits tipped workers into 'food_service' and
 * 'service_employee' categories per region: when occupation is omitted,
 * this defaults to whichever candidate is tagged 'food_service' — and
 * returns undefined, not a guess, for a region (upstate) whose food-service
 * figure IS the jurisdiction's own baseline tipped rate rather than a
 * distinct variant, so the caller falls through to that baseline correctly
 * instead of silently returning the wrong occupation's number.
 *
 * Also date-filtered: Oregon's regional rates step on the same July 1 as
 * its baseline, so a region can carry BOTH a current and a
 * historicalPredecessorOf entry sharing one id — dateInRange narrows to
 * whichever one actually covers `checkDate`.
 */
function resolveRegion(
  variants: MinimumWageAmount[] | undefined,
  kind: 'standard' | 'tipped',
  region: string,
  occupation: 'food_service' | 'service_employee' | undefined,
  checkDate: string,
): { amount: MinimumWageAmount | undefined; defaultedOccupation: boolean } {
  const needle = region.trim().toLowerCase();
  const candidates = (variants ?? []).filter(
    (v) =>
      v.regionalOverrideOf === kind &&
      (v.region ?? v.id ?? '').toLowerCase() === needle &&
      dateInRange(v, checkDate),
  );
  if (kind === 'standard' || candidates.length === 0) {
    return { amount: candidates[0], defaultedOccupation: false };
  }
  if (occupation) {
    return { amount: candidates.find((c) => c.occupation === occupation), defaultedOccupation: false };
  }
  const foodService = candidates.find((c) => c.occupation === 'food_service');
  return { amount: foodService, defaultedOccupation: foodService !== undefined && candidates.length > 1 };
}

/**
 * Pick the tier that actually applies to this employer, out of a
 * jurisdiction's default figure plus its variants.
 *
 * Returns the default untouched when the caller gave no headcount, or when
 * no variant declares a machine-readable one — with `narrowed: false` so
 * the caller can say so rather than implying a size test was performed.
 */
function selectTier(
  base: MinimumWageAmount,
  variants: MinimumWageAmount[] | undefined,
  query: MinimumWageQuery,
): { amount: MinimumWageAmount | undefined; narrowed: boolean; notCovered: boolean } {
  // Callers resolve any applicable historicalPredecessor (see that field's
  // own doc comment) or named region into `base` BEFORE calling this — it
  // is not done here, because a region-resolved base must not then be
  // overwritten by a non-regional predecessor entry sharing the same
  // variants array (Oregon has both, and they must never cross).
  const sized = (variants ?? []).filter(
    (v) => v.appliesWhen && dateInRange(v, query.checkDate),
  );
  if (sized.length === 0) return { amount: base, narrowed: false, notCovered: false };
  if (query.employeeCount === undefined) {
    return { amount: base, narrowed: false, notCovered: false };
  }
  if (sizeMatches(base, query.employeeCount) || base.appliesWhen === undefined) {
    // The jurisdiction's headline figure either matches the headcount test
    // it declares, or declares none at all — but a variant may still be the
    // better match, so keep looking before settling for it.
    const match = sized.find((v) => sizeMatches(v, query.employeeCount));
    if (match) {
      if (match.notCovered) return { amount: undefined, narrowed: true, notCovered: true };
      return { amount: match, narrowed: true, notCovered: false };
    }
    return { amount: base, narrowed: base.appliesWhen !== undefined, notCovered: false };
  }
  const match = sized.find((v) => sizeMatches(v, query.employeeCount));
  if (!match) return { amount: base, narrowed: false, notCovered: false };
  if (match.notCovered) return { amount: undefined, narrowed: true, notCovered: true };
  return { amount: match, narrowed: true, notCovered: false };
}

function findLocality(
  jurisdictions: MinimumWageJurisdiction[],
  locality: string,
): MinimumWageJurisdiction | undefined {
  const needle = locality.trim().toLowerCase();
  return jurisdictions.find(
    (j) => j.id.toLowerCase() === needle || j.name.toLowerCase() === needle,
  );
}

/** Every local ordinance researched for one state — for callers that need to search rather than name one. */
export function localMinimumWages(
  stateCode: string,
  checkDate: string,
): MinimumWageJurisdiction[] {
  return localMinimumWageRuleset(stateCode, checkDate);
}

/**
 * The binding minimum wage for one employee, and the trail that produced it.
 *
 * Throws only if the state/territory code has no ruleset at all — an
 * unrecognised LOCALITY is reported in the trail instead, because
 * "this city has no ordinance" and "you spelled the city wrong" must not
 * silently produce the same confident-looking number.
 */
export function minimumWage(query: MinimumWageQuery): MinimumWageAnswer {
  const considered: MinimumWageCandidate[] = [];

  // query.tipped is typed boolean, but MinimumWageQuery reaches this
  // function from outside TypeScript's reach too (this engine's shared
  // module is re-exported for a JSON API — see supabase/functions/_shared/
  // engine/index.ts) — the same class of gap already fixed for
  // certificate.exempt/nonresident and w4.exempt in taxes/state.ts and
  // taxes/federal.ts. A stray string "false" reaching here would silently
  // switch a caller from the standard rate to the TIPPED cash floor, or
  // vice versa — resolved once, strictly, rather than re-read as a bare
  // truthy value at each of the 4 call sites below (one of which,
  // tipCreditAllowed's own computation further down, already used the
  // correct `=== true` form — now all five agree).
  const tipped = resolveCertBoolean(query as unknown as Record<string, unknown>, 'tipped');

  const fed = federalMinimumWageRuleset(query.checkDate);
  const fedCents = tipped ? tippedCents(fed.tipped)! : toCents(fed.standard);
  considered.push({
    level: 'federal',
    jurisdiction: 'United States (FLSA)',
    cents: fedCents,
    basis: tipped
      ? 'FLSA tipped cash wage (29 U.S.C. 203(m))'
      : 'FLSA minimum wage (29 U.S.C. 206(a))',
  });

  if (!hasStateMinimumWageRuleset(query.state, query.checkDate)) {
    throw new Error(
      `No minimum wage ruleset for '${query.state}'. Rates are data, not code: add ` +
        `data/minimum-wage/states/${query.state.toUpperCase()}-<year>.json (with its ` +
        `source URL and verifiedOn date) rather than falling back to the federal floor silently.`,
    );
  }

  const state = stateMinimumWageRuleset(query.state, query.checkDate);
  if (state.standard === null) {
    // American Samoa: the federal floor there is 18 industry rates, and no
    // single number is a correct answer. Refuse rather than pick one.
    considered.push({
      level: 'state',
      jurisdiction: state.jurisdiction.name,
      basis: 'No single rate exists',
      caveat:
        'American Samoa has 18 industry-specific federal minimum wages ranging from $5.78 to ' +
        '$7.19; read industryRates from its ruleset and pick the employer’s own industry.',
    });
  } else if (tipped) {
    let cents = tippedCents(state.tipped);
    let basis = state.tipped.tipCreditAllowed
      ? 'State tipped cash wage'
      : 'State law allows no tip credit — the full state rate is owed in cash';
    let caveat: string | undefined;
    let regionMatched = false;
    if (query.region) {
      const region = resolveRegion(
        state.variants, 'tipped', query.region, query.occupation, query.checkDate,
      );
      if (region.amount) {
        regionMatched = true;
        cents = toCents(region.amount);
        basis =
          `State tipped cash wage, ${region.amount.label ?? query.region} region` +
          (region.amount.occupation ? ` (${region.amount.occupation})` : '');
        if (region.defaultedOccupation) {
          caveat =
            `Multiple tipped occupation categories exist for '${query.region}'; defaulted to ` +
            `'food_service' since none was specified.`;
        }
      } else if (!state.tipped.tipCreditAllowed) {
        // No distinct TIPPED variant for this region (Oregon never tags
        // one — Portland metro and non-urban have no tip credit either,
        // same as the state), but the state allows NO tip credit anywhere,
        // so the region's own STANDARD rate is the tipped cash floor. A
        // real bug this closes: without this branch, a tipped query for
        // Oregon's Portland metro silently returned the generic STATEWIDE
        // $15.55 instead of Portland metro's own $16.80 — found by the
        // coverage script printing the same figure for two different
        // regions and flagging it as suspicious, the same failure shape
        // already fixed once for Washington's local ordinances.
        const std = resolveRegion(state.variants, 'standard', query.region, undefined, query.checkDate);
        if (std.amount) {
          regionMatched = true;
          cents = toCents(std.amount);
          basis =
            `State law allows no tip credit — ${std.amount.label ?? query.region} region's own rate is the cash floor`;
        } else if (!hasRegions(state.variants)) {
          caveat = `${state.jurisdiction.name} has no named regions; 'region' was ignored.`;
        }
      } else if (!hasRegions(state.variants)) {
        caveat = `${state.jurisdiction.name} has no named regions; 'region' was ignored.`;
      }
      // Else: a real region with no distinct tipped variant, in a state
      // that DOES allow a tip credit (e.g. NY's 'upstate') — the baseline
      // tipped rate already IS that region's food-service figure, so
      // falling through to it is correct, not a fallback from an error.
    }
    if (!regionMatched) {
      const pred = historicalPredecessor(state.variants, 'tipped', query.checkDate);
      if (pred) {
        cents = toCents(pred);
        basis += ` (figure in effect through ${pred.effectiveTo ?? query.checkDate})`;
      } else {
        const scheduled = applicableScheduledChange(state, query.checkDate);
        const scheduledCents = state.tipped.tipCreditAllowed
          ? scheduled?.tippedCashWageCents
          : scheduled?.hourlyCents;
        if (scheduledCents != null) {
          cents = scheduledCents;
          basis += ` (scheduled change effective ${scheduled?.effectiveDate})`;
        }
      }
    }
    considered.push({ level: 'state', jurisdiction: state.jurisdiction.name, cents, basis, caveat });
  } else {
    let base = state.standard;
    let regionLabel: string | undefined;
    let regionCaveat: string | undefined;
    if (query.region) {
      const region = resolveRegion(state.variants, 'standard', query.region, undefined, query.checkDate);
      if (region.amount) {
        base = region.amount;
        regionLabel = region.amount.label ?? query.region;
      } else if (!hasRegions(state.variants)) {
        regionCaveat = `${state.jurisdiction.name} has no named regions; 'region' was ignored.`;
      }
    }
    if (!regionLabel) {
      const pred = historicalPredecessor(state.variants, 'standard', query.checkDate);
      base = pred ?? withScheduledStandard(base, state, query.checkDate);
    }
    const tier = selectTier(base, state.variants, query);
    considered.push({
      level: 'state',
      jurisdiction: state.jurisdiction.name,
      cents: tier.amount ? toCents(tier.amount as MinimumWageAmount) : undefined,
      basis: regionLabel
        ? `State rate, ${regionLabel} region`
        : tier.narrowed
          ? `State rate, ${(tier.amount as MinimumWageAmount)?.label ?? 'tier'} (${query.employeeCount} employees)`
          : 'State standard rate',
      caveat:
        regionCaveat ??
        (!tier.narrowed && (state.variants ?? []).some((v) => v.appliesWhen)
          ? 'This state publishes an employer-size tier; no employeeCount was supplied, so the headline rate is used.'
          : undefined),
    });
  }

  let foundLocal: MinimumWageJurisdiction | undefined;
  if (query.locality) {
    const locals = localMinimumWageRuleset(query.state, query.checkDate);
    const found = findLocality(locals, query.locality);
    foundLocal = found;
    if (!found) {
      considered.push({
        level: 'local',
        jurisdiction: query.locality,
        basis: 'No local ordinance found',
        caveat:
          locals.length === 0
            ? `No local minimum wage ordinances are recorded for ${query.state.toUpperCase()}.`
            : `'${query.locality}' is not one of the ${locals.length} ordinances recorded for ` +
              `${query.state.toUpperCase()}. This is reported, not treated as "no ordinance": ` +
              `check the spelling against localMinimumWages().`,
      });
    } else if (found.status) {
      considered.push({
        level: 'local',
        jurisdiction: found.name,
        basis: `Ordinance not applied — ${found.status}`,
        caveat: found.note as string | undefined,
      });
    } else if (
      found.effectiveFrom &&
      query.checkDate < found.effectiveFrom &&
      !(found.variants ?? []).some((v) => v.effectiveTo)
    ) {
      // An ordinance with a start date and no recorded earlier figure
      // contributes nothing before it: not "no ordinance", but not yet one.
      considered.push({
        level: 'local',
        jurisdiction: found.name,
        basis: `Ordinance not yet in effect — takes effect ${found.effectiveFrom}`,
        caveat: found.note as string | undefined,
      });
    } else if (tipped) {
      if (found.tipped) {
        const pred = historicalPredecessor(found.variants, 'tipped', query.checkDate);
        const scheduled = pred ? undefined : applicableScheduledChange(found, query.checkDate);
        const scheduledCents = found.tipped.tipCreditAllowed
          ? scheduled?.tippedCashWageCents
          : scheduled?.hourlyCents;
        considered.push({
          level: 'local',
          jurisdiction: found.name,
          cents: pred
            ? toCents(pred)
            : scheduledCents != null
              ? scheduledCents
              : tippedCents(found.tipped),
          basis:
            (found.tipped.tipCreditAllowed
              ? 'Local tipped cash wage'
              : 'Local ordinance allows no tip credit — the full local rate is owed in cash') +
            (pred
              ? ` (figure in effect through ${pred.effectiveTo ?? query.checkDate})`
              : scheduledCents != null
                ? ` (scheduled change effective ${scheduled?.effectiveDate})`
                : ''),
        });
      } else if (!state.tipped.tipCreditAllowed) {
        // The ordinance publishes no distinct tipped figure, but its STATE
        // bans tip credits outright — a fact that reaches every locality in
        // that state, not just the ones that bothered to restate it (found
        // live: Washington's own state file already asserted this in prose
        // for all 8 of its local ordinances, but the code never enforced
        // it, so a tipped Seattle query silently fell back to the STATE's
        // $17.13 instead of Seattle's own $21.30 full-cash floor). The
        // local standard rate — sized correctly via the same selectTier()
        // the non-tipped path uses — IS the tipped cash floor here.
        const pred = historicalPredecessor(found.variants, 'standard', query.checkDate);
        const base = pred ?? withScheduledStandard(found, found, query.checkDate);
        const tier = selectTier(base, found.variants, query);
        considered.push({
          level: 'local',
          jurisdiction: found.name,
          cents: tier.amount ? toCents(tier.amount as MinimumWageAmount) : undefined,
          basis: tier.notCovered
            ? 'Employer is below this ordinance’s size threshold — not covered'
            : 'No local tipped figure, but the state allows no tip credit anywhere — the local standard rate is the cash floor',
          caveat:
            !tier.narrowed && (found.variants ?? []).some((v) => v.appliesWhen)
              ? 'This ordinance publishes employer-size tiers; no employeeCount was supplied, so the headline rate is used.'
              : undefined,
        });
      } else {
        // The state DOES allow a credit, but neither this ordinance nor
        // this project's research has pinned down its own figure — never
        // guess a formula (localStandard − stateCredit has been checked
        // and found WRONG at least once: Montgomery County MD's real cash
        // wage is $4.00, not state's $3.63 scaled). Contribute nothing, so
        // the state's own tipped rate wins the comparison instead.
        considered.push({
          level: 'local',
          jurisdiction: found.name,
          basis: 'Ordinance publishes no separate tipped rate',
          caveat: 'No local tipped figure: the state tipped rule applies against the local rate.',
        });
      }
    } else {
      const pred = historicalPredecessor(found.variants, 'standard', query.checkDate);
      const base = pred ?? withScheduledStandard(found, found, query.checkDate);
      const tier = selectTier(base, found.variants, query);
      considered.push({
        level: 'local',
        jurisdiction: found.name,
        cents: tier.amount ? toCents(tier.amount as MinimumWageAmount) : undefined,
        basis: tier.notCovered
          ? 'Employer is below this ordinance’s size threshold — not covered'
          : tier.narrowed
            ? `Local rate, ${(tier.amount as MinimumWageAmount)?.label ?? 'tier'} (${query.employeeCount} employees)`
            : 'Local standard rate',
        caveat:
          !tier.narrowed && (found.variants ?? []).some((v) => v.appliesWhen)
            ? 'This ordinance publishes employer-size tiers; no employeeCount was supplied, so the headline rate is used.'
            : undefined,
      });
    }
  }

  let binding = considered[0]!;
  for (const c of considered) {
    if (c.cents !== undefined && c.cents > (binding.cents ?? -1)) binding = c;
  }

  const tipCreditAllowed =
    tipped
      ? binding.level === 'federal'
        ? fed.tipped.tipCreditAllowed
        : binding.level === 'state'
          ? state.tipped.tipCreditAllowed
          : (foundLocal?.tipped?.tipCreditAllowed ?? state.tipped.tipCreditAllowed)
      : false;

  return {
    cents: binding.cents!,
    hourly: binding.cents! / 100,
    bindingLevel: binding.level,
    bindingJurisdiction: binding.jurisdiction,
    tipCreditAllowed,
    considered,
  };
}
