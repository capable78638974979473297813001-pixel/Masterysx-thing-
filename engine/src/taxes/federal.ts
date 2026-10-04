import type { Cents } from '../money.ts';
import {
  applyRate,
  atLeastZero,
  dollars,
  fmt,
  overThreshold,
  roundHalfUp,
  underCap,
} from '../money.ts';
import type { Bracket, FederalRuleset } from '../registry.ts';
import { federalRuleset } from '../registry.ts';
import type {
  ComputeContext,
  FilingStatus,
  PaycheckInput,
  PretaxCategory,
  TaxLine,
} from '../types.ts';
import { cashEarnings, supplementalEarnings } from '../wages.ts';
import { resolveCertBoolean } from '../validate.ts';

/**
 * Pub 15-T publishes one schedule for "Single or Married Filing Separately".
 */
function scheduleKey(status: FilingStatus): string {
  return status === 'married_separate' ? 'single' : status;
}

function findBracket(schedule: Bracket[], annualWages: Cents): Bracket {
  for (const b of schedule) {
    const from = dollars(b.from);
    const to = b.to === null ? Infinity : dollars(b.to);
    if (annualWages >= from && annualWages < to) return b;
  }
  return schedule[schedule.length - 1];
}

/**
 * Federal income tax withholding — Publication 15-T, Worksheet 1A
 * (Percentage Method for Automated Payroll Systems).
 *
 * Line numbers in the comments map to the worksheet so the implementation can
 * be diffed against the published form when it changes each January.
 */
export function federalIncomeTax(
  input: PaycheckInput,
  ctx: ComputeContext,
  rules: FederalRuleset,
): TaxLine {
  const w4 = input.federalW4;
  const cfg = rules.incomeTax;
  const periods = ctx.periodsPerYear;

  // The full federal base spans every taxable earning, less federal-exempt
  // pretax. Supplemental wages (bonus/commission) are carved out and taxed on
  // the flat path instead (see federalSupplementalTax); pretax is applied to
  // the regular portion first, so the two lines together still tax the full
  // base. BUG FIXED 2026-09-02: this used to say that when pretax exceeds
  // regular wages, the remainder was "not spilled back onto supplemental —
  // a rare case documented rather than modelled in v1." That was a real
  // gap, not just a documented one — federalSupplementalTax() taxed the
  // raw, un-reduced bonus regardless, over-withholding whenever it
  // happened. Now fixed there (capped at Math.min(fullBase,
  // supplementalCash), which this function's own atLeastZero(fullBase -
  // supplementalCash) below algebraically guarantees agrees with this
  // REGULAR side); see federalSupplementalTax()'s own doc comment for the
  // proof and tests/engine.test.ts's two new spillover tests.
  const fullBase = ctx.taxableWagesFor(cfg.exemptPretax as PretaxCategory[]);
  const supplementalCash = supplementalEarnings(input.earnings);
  let taxableWages = atLeastZero(fullBase - supplementalCash);

  // Pub 15-T's nonresident alien withholding adjustment: add a fixed
  // per-period amount to wages BEFORE annualizing (Steps 1-2 of that
  // procedure), then run the ordinary worksheet on the inflated figure —
  // the added amount is excluded from taxableWages reported on the line
  // itself (Pub 15-T: it "shouldn't be included in any box on the
  // employee's Form W-2 and doesn't increase the income tax liability"),
  // so it's tracked separately and only folded into the ANNUALIZED figure
  // below, not into the TaxLine's own taxableWages field.
  // w4 is typed FederalW4 (nonresidentAlien/exempt both declared boolean),
  // but that only binds a TypeScript caller — this engine is also served
  // as a JSON API (supabase/functions/calculate-paycheck), where nothing
  // stops a string "false" arriving on the wire. resolveCertBoolean()
  // catches that the same way it now does for every certificate.* boolean
  // in taxes/state.ts, rather than trusting the type annotation alone.
  const w4Raw = w4 as unknown as Record<string, unknown>;
  const nraAdjustment = resolveCertBoolean(w4Raw, 'nonresidentAlien')
    ? dollars(cfg.nonresidentAlienAdjustment[input.payFrequency] ?? 0)
    : 0;

  const line = (amount: Cents, detail: string): TaxLine => ({
    id: 'US_FIT',
    name: 'Federal Income Tax',
    payer: 'employee',
    jurisdiction: 'federal',
    taxableWages,
    amount,
    detail,
  });

  if (resolveCertBoolean(w4Raw, 'exempt')) {
    return line(0, 'Employee claimed exempt on Form W-4');
  }

  // Step 1 — annualise and adjust.
  const annualWages = (taxableWages + nraAdjustment) * periods; // 1c
  const withOther = annualWages + w4.otherIncome; // 1e

  // 1g: zero when the Step 2 checkbox is marked, because the multiple-jobs
  // schedules already have the adjustment built into their bracket widths.
  const standardAdj = w4.multipleJobs
    ? 0
    : dollars(
        w4.filingStatus === 'married_joint'
          ? cfg.step1StandardAdjustment.married_joint
          : cfg.step1StandardAdjustment.other,
      );

  const totalDeductions = w4.deductions + standardAdj; // 1h
  const adjustedAnnual = atLeastZero(withOther - totalDeductions); // 1i

  // Step 2 — bracket lookup.
  const schedules = w4.multipleJobs
    ? cfg.multipleJobsSchedules
    : cfg.standardSchedules;
  const schedule = schedules[scheduleKey(w4.filingStatus)];
  if (!schedule) {
    throw new Error(
      `No 2026 federal schedule for filing status "${w4.filingStatus}"`,
    );
  }

  const bracket = findBracket(schedule, adjustedAnnual);
  const excess = adjustedAnnual - dollars(bracket.from); // 2e
  const tentativeAnnual =
    dollars(bracket.base) + applyRate(excess, bracket.rate); // 2g
  const tentativePerPeriod = Math.round(tentativeAnnual / periods); // 2h

  // Step 3 — dependent and other credits.
  const creditPerPeriod = Math.round(w4.dependentCredit / periods); // 3b
  const afterCredits = atLeastZero(tentativePerPeriod - creditPerPeriod); // 3c

  // Step 4 — additional withholding requested by the employee.
  const total = afterCredits + w4.extraWithholding; // 4b

  const detail =
    (nraAdjustment
      ? `NRA adjustment +${fmt(nraAdjustment)}/period (Pub 15-T Table 2, not reported as wages); `
      : '') +
    `annualised ${fmt(annualWages)} → adjusted ${fmt(adjustedAnnual)}; ` +
    `bracket ${(bracket.rate * 100).toFixed(0)}% over ${fmt(dollars(bracket.from))}; ` +
    `tentative/yr ${fmt(tentativeAnnual)} ÷ ${periods}` +
    (creditPerPeriod ? `; less credits ${fmt(creditPerPeriod)}` : '') +
    (w4.extraWithholding ? `; plus extra ${fmt(w4.extraWithholding)}` : '');

  return line(total, detail);
}

/**
 * Federal income tax on supplemental wages (bonus, commission) — Pub 15
 * flat-rate method. A flat 22% on supplemental wages, and a mandatory 37% on
 * the portion of cumulative supplemental wages above $1,000,000 in the calendar
 * year. Returns null when there are no supplemental earnings, so a plain
 * paycheck is unaffected.
 *
 * This is a separate line from US_FIT so the breakdown stays auditable: a
 * customer can see exactly what withholding the bonus drove.
 *
 * BUG FIXED 2026-09-02: pretax deductions are applied against the REGULAR
 * portion of wages first (federalIncomeTax()'s own convention — see its
 * "pretax is applied to the regular portion first" comment), and when a
 * pretax deduction EXCEEDS regular wages, the excess must spill over onto
 * the supplemental base too, since the combined pretax deduction reduces
 * total taxable income regardless of which earning line it's nominally
 * attached to. This function used to tax the raw, un-reduced
 * supplementalCash figure regardless — for $500 regular wages, a $2,000
 * 401(k) deferral, and a $5,000 bonus, it taxed the full $5,000 at 22%
 * ($1,100) instead of the correct $3,500 ($500+$5,000−$2,000 = $770),
 * over-withholding by $330. Fixed by capping the taxed amount at
 * ctx.taxableWagesFor()'s own combined net base — algebraically equal to
 * Math.min(fullBase, supplementalCash) (proof: federalIncomeTax()'s own
 * REGULAR-side taxableWages is atLeastZero(fullBase - supplementalCash);
 * fullBase minus THAT already equals min(fullBase, supplementalCash) in
 * every case — no pretax exceeding regular, pretax exceeding regular but
 * not the combined total, and pretax exceeding the combined total too).
 * The REGULAR side was never wrong — only this function's own figure was.
 */
export function federalSupplementalTax(
  input: PaycheckInput,
  ctx: ComputeContext,
  rules: FederalRuleset,
): TaxLine | null {
  const rawSupplementalCash = supplementalEarnings(input.earnings);
  if (rawSupplementalCash <= 0) return null;

  const cfg = rules.incomeTax;
  const fullBase = ctx.taxableWagesFor(cfg.exemptPretax as PretaxCategory[]);
  const supplementalCash = Math.min(fullBase, rawSupplementalCash);

  // An exempt W-4 claims no federal income tax liability at all, supplemental
  // included; nothing is withheld. Same strict boolean read as
  // federalIncomeTax() — a string "false" must throw, not withhold $0.
  if (resolveCertBoolean(input.federalW4 as unknown as Record<string, unknown>, 'exempt')) {
    return {
      id: 'US_FIT_SUPP',
      name: 'Federal Income Tax (Supplemental)',
      payer: 'employee',
      jurisdiction: 'federal',
      taxableWages: supplementalCash,
      amount: 0,
      detail: 'Employee claimed exempt on Form W-4',
    };
  }

  const threshold = dollars(cfg.supplementalMandatoryThreshold);
  const ytdSupp = input.ytd.supplemental ?? 0;
  const over = overThreshold(supplementalCash, ytdSupp, threshold);
  const under = supplementalCash - over;

  // One rounding for the whole line even across the two rate bands
  // (docs/rounding-and-precision.md rule 4).
  const amount = roundHalfUp(
    under * cfg.supplementalRate + over * cfg.supplementalMandatoryRate,
  );

  const spillover = rawSupplementalCash - supplementalCash;
  const detail =
    (over
      ? `${fmt(under)} @ ${(cfg.supplementalRate * 100).toFixed(0)}% + ` +
        `${fmt(over)} @ ${(cfg.supplementalMandatoryRate * 100).toFixed(0)}% ` +
        `(cumulative supplemental over ${fmt(threshold)})`
      : `${fmt(supplementalCash)} @ ${(cfg.supplementalRate * 100).toFixed(0)}% flat supplemental rate`) +
    (spillover > 0
      ? ` — reduced from the raw ${fmt(rawSupplementalCash)} bonus: pretax deductions exceeded regular ` +
        `wages by ${fmt(spillover)}, and that excess spills onto the supplemental base too`
      : '');

  return {
    id: 'US_FIT_SUPP',
    name: 'Federal Income Tax (Supplemental)',
    payer: 'employee',
    jurisdiction: 'federal',
    taxableWages: supplementalCash,
    amount,
    detail,
  };
}

/** Social Security (OASDI) — capped at the annual wage base. */
export function socialSecurity(
  input: PaycheckInput,
  ctx: ComputeContext,
  rules: FederalRuleset,
): TaxLine[] {
  const cfg = rules.socialSecurity;
  const base = ctx.taxableWagesFor(cfg.exemptPretax as PretaxCategory[]);
  const cap = dollars(cfg.wageBase);
  const taxable = underCap(base, input.ytd.socialSecurity, cap);

  const detail =
    taxable < base
      ? `capped: ${fmt(input.ytd.socialSecurity)} YTD against ${fmt(cap)} wage base`
      : `${fmt(taxable)} @ 6.2%`;

  return [
    {
      id: 'US_SS_EE',
      name: 'Social Security',
      payer: 'employee',
      jurisdiction: 'federal',
      taxableWages: taxable,
      amount: applyRate(taxable, cfg.employeeRate),
      detail,
    },
    {
      id: 'US_SS_ER',
      name: 'Social Security (Employer)',
      payer: 'employer',
      jurisdiction: 'federal',
      taxableWages: taxable,
      amount: applyRate(taxable, cfg.employerRate),
      detail,
    },
  ];
}

/** Medicare, plus the employee-only Additional Medicare surtax. */
export function medicare(
  input: PaycheckInput,
  ctx: ComputeContext,
  rules: FederalRuleset,
): TaxLine[] {
  const cfg = rules.medicare;
  const taxable = ctx.taxableWagesFor(cfg.exemptPretax as PretaxCategory[]);

  const lines: TaxLine[] = [
    {
      id: 'US_MED_EE',
      name: 'Medicare',
      payer: 'employee',
      jurisdiction: 'federal',
      taxableWages: taxable,
      amount: applyRate(taxable, cfg.employeeRate),
      detail: `${fmt(taxable)} @ 1.45%, no wage cap`,
    },
    {
      id: 'US_MED_ER',
      name: 'Medicare (Employer)',
      payer: 'employer',
      jurisdiction: 'federal',
      taxableWages: taxable,
      amount: applyRate(taxable, cfg.employerRate),
      detail: `${fmt(taxable)} @ 1.45%, no wage cap`,
    },
  ];

  // Additional Medicare: employee only, on wages above the threshold.
  // The employer applies the flat $200,000 trigger regardless of filing
  // status; any over/under is settled by the employee on Form 8959.
  const threshold = dollars(cfg.additional.threshold);
  const surtaxBase = overThreshold(taxable, input.ytd.medicare, threshold);
  if (surtaxBase > 0) {
    lines.push({
      id: 'US_MED_ADDL',
      name: 'Additional Medicare',
      payer: 'employee',
      jurisdiction: 'federal',
      taxableWages: surtaxBase,
      amount: applyRate(surtaxBase, cfg.additional.rate),
      detail: `${fmt(surtaxBase)} of this cheque exceeds the ${fmt(threshold)} threshold @ 0.9%`,
    });
  }

  return lines;
}

/** FUTA — employer only, capped, and assumes the full state credit. */
interface FutaCreditReductionConfig {
  /** Additional rate by state code, on top of the net 0.6% — e.g. 0.012 for a 1.2% reduction. Empty while the year is undetermined. */
  states?: Record<string, number>;
  /** The date after which the year's determination is made (November 10 each year). */
  determinationDate?: string;
  priorYear?: { year: number; states: Record<string, number> };
}

/**
 * FUTA, including CREDIT REDUCTION.
 *
 * The 0.6% everyone quotes is 6.0% less a 5.4% credit for the state
 * unemployment tax the employer also pays. A state that borrowed from the
 * federal unemployment account and has not repaid loses part of that
 * credit, so employers there pay MORE than 0.6% — retroactively, for the
 * whole year, on wages already paid. For 2025 that was California at an
 * extra 1.2% (net 1.8%) and the Virgin Islands at an extra 4.5% (net
 * 5.1%); Connecticut and New York were on the potential list in January
 * and repaid before the deadline, which is exactly why the figure cannot
 * be predicted from a state having debt earlier in the year.
 *
 * The determination is made after NOVEMBER 10 of the year the wages are
 * paid, so for most of any given year the correct answer is 'not yet
 * determined'. This models that honestly: the rate is applied when the
 * jurisdiction file carries one for its own year, and when it does not,
 * the line says the determination is pending rather than implying 0.6% is
 * final. The prior year's final figures ride along in the data as the
 * reference they are, never as a substitute.
 */
export function futa(
  input: PaycheckInput,
  ctx: ComputeContext,
  rules: FederalRuleset,
): TaxLine[] {
  const cfg = rules.futa;
  const base = ctx.taxableWagesFor(cfg.exemptPretax as PretaxCategory[]);
  const cap = dollars(cfg.wageBase);
  const taxable = underCap(base, input.ytd.futa, cap);

  if (taxable === 0) {
    return [
      {
        id: 'US_FUTA',
        name: 'FUTA',
        payer: 'employer',
        jurisdiction: 'federal',
        taxableWages: 0,
        amount: 0,
        detail: `wage base ${fmt(cap)} already met`,
      },
    ];
  }

  const reduction = (cfg as { creditReduction?: FutaCreditReductionConfig }).creditReduction;
  const state = input.workState?.code;
  const extra = state ? (reduction?.states?.[state] ?? 0) : 0;
  const rate = cfg.netRate + extra;

  const pending =
    extra === 0 &&
    reduction?.determinationDate !== undefined &&
    Object.keys(reduction.states ?? {}).length === 0;

  return [
    {
      id: 'US_FUTA',
      name: 'FUTA',
      payer: 'employer',
      jurisdiction: 'federal',
      taxableWages: taxable,
      amount: applyRate(taxable, rate),
      detail:
        extra > 0
          ? `${fmt(taxable)} @ ${(rate * 100).toFixed(1)}% — 0.6% net of the state credit PLUS a ${(extra * 100).toFixed(1)}% credit reduction, ${state} having not repaid its federal unemployment loans`
          : `${fmt(taxable)} @ 0.6% net of the 5.4% state credit` +
            (pending
              ? `; no credit reduction is applied because this year's determination is made after ${reduction!.determinationDate} and had not been published when this ruleset was written — a reduction, if any, applies retroactively to the whole year`
              : ''),
    },
  ];
}

/**
 * Employment categories the Code taxes differently.
 *
 * CLERGY. IRS guidance is explicit and unusually broad: a minister's
 * earnings for services in the exercise of the ministry "are not subject to
 * income, social security, and Medicare tax withholding" — the minister
 * pays self-employment tax under SECA instead — and those services are
 * excluded from FUTA employment as well. So every federal line goes to
 * zero. The one exception is an income tax withholding the employer and
 * minister agree to VOLUNTARILY, which the IRS explicitly permits and says
 * to report in box 2 of the W-2; that arrives as
 * federalW4.voluntaryWithholdingAgreement.
 *
 * STATUTORY EMPLOYEE. The mirror image, and the reason these two share a
 * function: Publication 15 says not to withhold federal income tax from
 * someone who is not a common-law employee, while social security and
 * Medicare taxes MUST be withheld because such a worker is an employee by
 * statute for FICA purposes. So income tax alone goes to zero.
 *
 * Zero LINES rather than missing ones: a payroll register that simply omits
 * social security for a minister looks identical to one that forgot it. The
 * line stays, at zero, carrying the reason.
 */
interface CoverageThresholds {
  household?: { annualCashWages: number; futaQuarterlyCashWages: number };
  agricultural?: { annualCashWagesPerWorker: number; annualWagesAllFarmworkers: number };
  electionWorker?: { annualCashWages: number };
}

/**
 * Whether a household or agricultural worker's pay is covered yet.
 *
 * Both categories work the same way and neither is a rate change: the
 * taxes are ordinary FICA and FUTA, and the only question is whether this
 * worker is inside the system at all. Domestic employment comes in when
 * cash wages to that worker reach the year's coverage threshold ($3,000
 * for 2026, indexed annually); farm work comes in when the worker is paid
 * $150 in the year OR the employer pays $2,500 to all farmworkers, either
 * test being enough on its own.
 *
 * DISCLOSED LIMIT: crossing a threshold makes the year's EARLIER wages
 * taxable too, and this engine computes one cheque at a time — so it
 * starts withholding from the cheque that crosses the line and does not
 * reach back to collect on wages already paid. The catch-up is real and
 * belongs to the employer; the federal ruleset says so in its own
 * employmentCategories block rather than the code implying otherwise.
 */
function categoryCoverage(
  input: PaycheckInput,
  ctx: ComputeContext,
  rules: FederalRuleset,
): { ficaCovered: boolean; futaCovered: boolean; reason: string } | null {
  const category = input.employmentCategory;
  if (category !== 'household' && category !== 'agricultural' && category !== 'election_worker') {
    return null;
  }

  const thresholds = (rules.employmentCategories as { coverageThresholds?: CoverageThresholds } | undefined)
    ?.coverageThresholds;
  const cashThisCheque = cashEarnings(input.earnings);
  const cashToDate = (input.ytd.categoryCashWages ?? 0) + cashThisCheque;

  if (category === 'election_worker') {
    const cfg = thresholds?.electionWorker;
    if (!cfg) return null;
    const ficaCovered = cashToDate >= dollars(cfg.annualCashWages);
    return {
      ficaCovered,
      // Election work is government employment, which is outside FUTA
      // whatever the amounts — there is no threshold to cross.
      futaCovered: false,
      reason: ficaCovered
        ? `election work: ${fmt(cashToDate)} paid this year meets the ${cfg.annualCashWages} threshold at which election workers come into social security and Medicare`
        : `$0 — election work: ${fmt(cashToDate)} paid this year is under the ${cfg.annualCashWages} threshold (input.ytd.categoryCashWages), below which an election worker is outside social security and Medicare entirely.`,
    };
  }

  if (category === 'household') {
    const cfg = thresholds?.household;
    if (!cfg) return null;
    const ficaCovered = cashToDate >= dollars(cfg.annualCashWages);
    // Same convention as categoryCashWages: the caller stores quarter-to-date
    // BEFORE this check. A cheque that itself crosses $1,000 is covered.
    const quarterly = (input.employer?.householdQuarterlyCashWages ?? 0) + cashThisCheque;
    const futaCovered = quarterly >= dollars(cfg.futaQuarterlyCashWages);
    return {
      ficaCovered,
      futaCovered,
      reason: ficaCovered
        ? `household employment: ${fmt(cashToDate)} of cash wages this year meets the $${cfg.annualCashWages} coverage threshold`
        : `$0 — household employment: ${fmt(cashToDate)} of cash wages this year is under the $${cfg.annualCashWages} coverage threshold (input.ytd.categoryCashWages). Crossing it later makes earlier wages from the same year taxable too, which this engine does not reach back to collect.`,
    };
  }

  const cfg = thresholds?.agricultural;
  if (!cfg) return null;
  const perWorkerMet = cashToDate >= dollars(cfg.annualCashWagesPerWorker);
  const farmTotalMet = (input.employer?.agriculturalTotalWages ?? 0) >= dollars(cfg.annualWagesAllFarmworkers);
  const ficaCovered = perWorkerMet || farmTotalMet;
  return {
    ficaCovered,
    futaCovered: input.employer?.agriculturalFutaLiable === true,
    reason: ficaCovered
      ? `farm work: ${perWorkerMet ? `${fmt(cashToDate)} paid to this worker meets the $${cfg.annualCashWagesPerWorker} test` : `the farm payroll meets the $${cfg.annualWagesAllFarmworkers} test`}`
      : `$0 — farm work: neither test is met — ${fmt(cashToDate)} paid to this worker is under $${cfg.annualCashWagesPerWorker}, and the total farm payroll (input.employer.agriculturalTotalWages) is under $${cfg.annualWagesAllFarmworkers}.`,
  };
}

interface RailroadRetirementConfig {
  tier2: { employeeRate: number; employerRate: number; wageBase: number };
}

/**
 * Railroad retirement, Tier II — the part of rail employment that has no
 * FICA equivalent at all.
 *
 * Tier I is arithmetically identical to social security and Medicare (the
 * same 6.20% to the same wage base, the same 1.45% uncapped, the same 0.9%
 * additional Medicare), which is why this function does not recompute it —
 * the ordinary lines are relabelled instead, because the amounts are right
 * and only the name of the tax is wrong. Tier II is genuinely additional:
 * 4.9% from the employee and 13.1% from the employer for 2026, on
 * compensation up to $137,100 — a wage base that runs out well before
 * social security's own.
 */
interface RUIAConfig {
  newEmployerRate: number;
  monthlyCompensationBase: number;
}

/**
 * Railroad unemployment contributions (RUIA) — the tax rail employers pay
 * INSTEAD of FUTA, which is why zeroing their FUTA line without computing
 * this would have understated the cost of a rail paycheck rather than
 * corrected it.
 *
 * Two things make it unlike every other unemployment tax here. It is
 * experience-rated across an unusually wide band — 0.65% for the 91% of
 * covered employers at the floor, up to 12.0% at the ceiling — so the
 * employer's own rate arrives as input, with the published new-employer
 * rate (5.58% for 2026, the average paid by all employers over 2022-2024)
 * as the fallback. And it caps MONTHLY rather than annually, at $2,150 of
 * compensation a month, so its running total resets twelve times a year
 * and the caller keeps it in ytd.railroadMonthlyCompensation.
 */
function railroadUnemployment(
  input: PaycheckInput,
  ctx: ComputeContext,
  rules: FederalRuleset,
): TaxLine[] {
  const cfg = (rules.railroadRetirement as { ruia?: RUIAConfig } | undefined)?.ruia;
  if (!cfg) return [];

  const rate = input.employer?.railroadUnemploymentRate ?? cfg.newEmployerRate;
  // RRTA compensation tracks FICA wages: elective deferrals stay in the
  // base. The income-tax exempt list would drop 401(k)/403(b)/457/SIMPLE
  // and understate both this contribution and the monthly cap.
  const exempt = rules.socialSecurity.exemptPretax as PretaxCategory[];
  const compensation = ctx.taxableWagesFor(exempt);
  const cap = dollars(cfg.monthlyCompensationBase);
  const alreadyThisMonth = input.ytd.railroadMonthlyCompensation ?? 0;
  const taxableWages = underCap(compensation, alreadyThisMonth, cap);

  const supplied = input.employer?.railroadUnemploymentRate !== undefined;
  return [
    {
      id: 'US_RUIA_ER',
      name: 'Railroad Unemployment Insurance (Employer)',
      payer: 'employer',
      jurisdiction: 'federal',
      taxableWages,
      amount: applyRate(taxableWages, rate),
      detail:
        `${fmt(taxableWages)} @ ${(rate * 100).toFixed(2)}% — ` +
        (supplied
          ? "this employer's own experience-rated RUIA rate"
          : "the published new-employer rate (no rate supplied — see input.employer.railroadUnemploymentRate)") +
        `, capped at ${fmt(cap)} of compensation per MONTH (${fmt(alreadyThisMonth)} already counted this month)`,
    },
  ];
}

function railroadTier2(
  input: PaycheckInput,
  ctx: ComputeContext,
  rules: FederalRuleset,
): TaxLine[] {
  const cfg = rules.railroadRetirement as RailroadRetirementConfig | undefined;
  if (!cfg) return [];

  // Same FICA wage base as RUIA and Tier I — deferrals are compensation.
  const exempt = rules.socialSecurity.exemptPretax as PretaxCategory[];
  const compensation = ctx.taxableWagesFor(exempt);
  const cap = dollars(cfg.tier2.wageBase);
  const ytd = input.ytd.tier2Compensation ?? 0;
  const taxableWages = underCap(compensation, ytd, cap);

  const line = (suffix: string, payer: TaxLine["payer"], rate: number): TaxLine => ({
    id: `US_RRTA_TIER2_${suffix}`,
    name: `Railroad Retirement Tier II (${payer === "employee" ? "Employee" : "Employer"})`,
    payer,
    jurisdiction: 'federal',
    taxableWages,
    amount: applyRate(taxableWages, rate),
    detail: `${fmt(taxableWages)} @ ${(rate * 100).toFixed(2)}%, capped at ${fmt(cap)}/yr (${fmt(ytd)} YTD already counted)`,
  });

  return [
    line('EE', 'employee', cfg.tier2.employeeRate),
    line('ER', 'employer', cfg.tier2.employerRate),
  ];
}

/** Tier I is the same money as FICA under a different statute — relabel rather than recompute. */
function asRailroadTierOne(line: TaxLine): TaxLine {
  const RENAMES: Record<string, { id: string; name: string }> = {
    US_SS_EE: { id: 'US_RRTA_TIER1_EE', name: 'Railroad Retirement Tier I (Employee)' },
    US_SS_ER: { id: 'US_RRTA_TIER1_ER', name: 'Railroad Retirement Tier I (Employer)' },
    US_MED_EE: { id: 'US_RRTA_MED_EE', name: 'Railroad Retirement Tier I Medicare (Employee)' },
    US_MED_ER: { id: 'US_RRTA_MED_ER', name: 'Railroad Retirement Tier I Medicare (Employer)' },
    US_MED_ADDL: { id: 'US_RRTA_MED_ADDL', name: 'Railroad Retirement Additional Medicare (Employee)' },
  };
  const renamed = RENAMES[line.id];
  if (!renamed) return line;
  return {
    ...line,
    id: renamed.id,
    name: renamed.name,
    detail: `${line.detail}; levied under the Railroad Retirement Tax Act rather than FICA — same rate and wage base, different tax and different return (Form CT-1)`,
  };
}

function applyEmploymentCategory(
  input: PaycheckInput,
  lines: TaxLine[],
  coverage: ReturnType<typeof categoryCoverage> = null,
): TaxLine[] {
  const category = input.employmentCategory ?? 'standard';
  if (category === 'standard') return lines;

  if (category === 'railroad') {
    return lines.map((line) => {
      if (line.id === 'US_FUTA') {
        return {
          ...line,
          taxableWages: 0,
          amount: 0,
          detail:
            '$0 — rail employment is outside FUTA. Railroad employers pay unemployment contributions under the Railroad Unemployment Insurance Act instead; that amount is the US_RUIA_ER line on this paycheck.',
        };
      }
      return asRailroadTierOne(line);
    });
  }

  if (category === 'household' || category === 'agricultural' || category === 'election_worker') {
    if (!coverage) return lines;
    return lines.map((line) => {
      const isIncomeTax = line.id === 'US_FIT' || line.id === 'US_FIT_SUPP';
      const isFuta = line.id === 'US_FUTA';

      // Domestic employment carries no income tax withholding requirement
      // at all; farm work carries the same requirement as ordinary wages,
      // but only once the worker is covered.
      if (isIncomeTax) {
        if (category === 'election_worker' && input.federalW4.voluntaryWithholdingAgreement !== true) {
          return {
            ...line,
            taxableWages: 0,
            amount: 0,
            detail:
              "$0 — election work: an election worker's pay is not subject to federal income tax withholding, though it is still taxable income to the worker. Set federalW4.voluntaryWithholdingAgreement if withholding was requested.",
          };
        }
        if (category === 'household' && input.federalW4.voluntaryWithholdingAgreement !== true) {
          return {
            ...line,
            taxableWages: 0,
            amount: 0,
            detail:
              "$0 — household employment: federal income tax withholding is not required from a household employee. Set federalW4.voluntaryWithholdingAgreement if the employer and employee agreed to withhold anyway.",
          };
        }
        if (category === 'agricultural' && !coverage.ficaCovered) {
          return { ...line, taxableWages: 0, amount: 0, detail: coverage.reason };
        }
        return line;
      }

      const covered = isFuta ? coverage.futaCovered : coverage.ficaCovered;
      if (covered) return line;
      return {
        ...line,
        taxableWages: 0,
        amount: 0,
        detail: isFuta
          ? `$0 — ${
              category === 'household'
                ? 'household employment: cash wages to all household employees have not reached $1,000 in a calendar quarter. input.employer.householdQuarterlyCashWages is quarter-to-date before this check; this check’s cash wages are counted on top of it'
                : category === 'election_worker'
                  ? 'election work is service for a state or local government, which is outside FUTA employment entirely'
                  : "farm work: the employer has not asserted the agricultural FUTA test (input.employer.agriculturalFutaLiable)"
            }.`
          : coverage.reason,
      };
    });
  }

  const voluntary = input.federalW4.voluntaryWithholdingAgreement === true;
  const zeroOut = (line: TaxLine, reason: string): TaxLine => ({
    ...line,
    taxableWages: 0,
    amount: 0,
    detail: reason,
  });

  return lines.map((line) => {
    const isIncomeTax = line.id === 'US_FIT' || line.id === 'US_FIT_SUPP';
    if (category === 'statutory_employee') {
      return isIncomeTax
        ? zeroOut(
            line,
            '$0 — statutory employee: Publication 15 directs an employer not to withhold federal income tax from a worker who is not a common-law employee. Social security and Medicare are still withheld, because such a worker IS an employee by statute for FICA.',
          )
        : line;
    }

    // Clergy: every federal line goes to zero.
    if (isIncomeTax && voluntary) return line;
    return zeroOut(
      line,
      isIncomeTax
        ? '$0 — clergy: a minister\'s earnings for services in the exercise of the ministry are not subject to income tax withholding. An employer and minister MAY agree to withhold voluntarily; set federalW4.voluntaryWithholdingAgreement to do that.'
        : '$0 — clergy: services performed in the exercise of the ministry are outside social security, Medicare and FUTA employment. The minister pays self-employment tax under SECA instead.',
    );
  });
}

export function federalTaxes(
  input: PaycheckInput,
  ctx: ComputeContext,
): TaxLine[] {
  const rules = federalRuleset(input.checkDate);
  const supplemental = federalSupplementalTax(input, ctx, rules);
  return applyEmploymentCategory(
    input,
    [
    federalIncomeTax(input, ctx, rules),
    ...(supplemental ? [supplemental] : []),
    ...socialSecurity(input, ctx, rules),
    ...medicare(input, ctx, rules),
      ...futa(input, ctx, rules),
      ...(input.employmentCategory === 'railroad'
        ? [...railroadTier2(input, ctx, rules), ...railroadUnemployment(input, ctx, rules)]
        : []),
    ],
    categoryCoverage(input, ctx, rules),
  );
}
