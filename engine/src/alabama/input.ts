import { dollars } from '../money.ts';
import type { Cents } from '../money.ts';
import { alCountyRuleset, alMunicipalityRuleset, hasStateRuleset, stateRuleset } from '../registry.ts';
import { PERIODS_PER_YEAR } from '../types.ts';
import type {
  Deduction,
  Earning,
  EmploymentCategory,
  FilingStatus,
  PaycheckInput,
  PayFrequency,
  PretaxCategory,
} from '../types.ts';
import type {
  A4ExemptionCode,
  AlabamaEarning,
  AlabamaPaycheckInput,
  Dollars,
} from './types.ts';

/**
 * A rejected Alabama input. Thrown, not returned, and thrown with the field
 * name and the accepted values in the message: a payroll input that is
 * wrong should fail loudly at the boundary, because the alternative — a
 * silently coerced value — is a wrong paycheque that looks right.
 */
export class AlabamaInputError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      problems.length === 1
        ? `Invalid Alabama paycheck input: ${problems[0]}`
        : `Invalid Alabama paycheck input:\n  - ${problems.join('\n  - ')}`,
    );
    this.name = 'AlabamaInputError';
    this.problems = problems;
  }
}

const A4_CODES: readonly A4ExemptionCode[] = ['0', 'S', 'MS', 'M', 'H'];

const FILING_STATUSES: readonly FilingStatus[] = [
  'single',
  'married_joint',
  'married_separate',
  'head_of_household',
];

const EMPLOYMENT_CATEGORIES: readonly EmploymentCategory[] = [
  'standard',
  'clergy',
  'statutory_employee',
  'household',
  'agricultural',
  'railroad',
  'election_worker',
];

const PRETAX_CATEGORIES: readonly PretaxCategory[] = [
  'section125',
  'hsa',
  'fsa',
  'dependent_care',
  'deferral_401k',
  'deferral_403b',
  'deferral_457',
  'deferral_simple',
  'commuter',
];

const EARNING_CATEGORIES: readonly AlabamaEarning['category'][] = [
  'regular',
  'supplemental',
  'imputed',
  'reimbursement',
  'housing_allowance',
];

/** What buildAlabamaEngineInput() hands back: the engine call plus context. */
export interface AlabamaBuildResult {
  engineInput: PaycheckInput;
  warnings: string[];
  /** Resolved A-4 values after defaults, for the output's own summary. */
  a4: { exemptionCode: A4ExemptionCode; dependents: number };
  /** The work city as matched against the occupational-tax list, if it matched. */
  matchedCity?: { name: string; rate: number };
  matchedCounty?: { name: string; rate: number };
}

function requireMoney(
  problems: string[],
  label: string,
  value: Dollars | undefined,
): Cents {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${label} must be a finite number of dollars, got ${JSON.stringify(value)}`);
    return 0;
  }
  if (value < 0) {
    problems.push(
      `${label} must not be negative (${value}). A negative earning or deduction is a correction, ` +
        `and a correction is its own paycheque — model it as one rather than as a negative line here.`,
    );
    return 0;
  }
  return dollars(value);
}

function pushEarning(
  into: Earning[],
  code: string,
  category: Earning['category'],
  amount: Cents,
): void {
  if (amount > 0) into.push({ code, category, amount });
}

/**
 * Turn an Alabama-shaped input into the engine's own PaycheckInput.
 *
 * Everything Alabama-specific that the engine reads out of a free-form
 * `certificate` bag is assembled here, in one place, from named fields: the
 * A-4 exemption code and dependents, Line 5's additional withholding, the
 * work city for the municipal occupational tax, the day count Act 2025-334
 * turns on, the nonresident allocation fraction, and the three severance
 * fields. A caller of this module never has to know those key names — which
 * is the point, since getting one of them wrong produces a plausible
 * paycheque with a silently missing tax.
 */
export function buildAlabamaEngineInput(input: AlabamaPaycheckInput): AlabamaBuildResult {
  const problems: string[] = [];
  const warnings: string[] = [];

  // --- check date -------------------------------------------------------
  if (typeof input.checkDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.checkDate)) {
    problems.push(`checkDate must be an ISO yyyy-mm-dd string, got ${JSON.stringify(input.checkDate)}`);
  } else if (Number.isNaN(Date.parse(input.checkDate))) {
    problems.push(`checkDate ${input.checkDate} is not a real date`);
  } else if (!hasStateRuleset('AL', input.checkDate)) {
    problems.push(
      `no Alabama ruleset for ${input.checkDate.slice(0, 4)} — rates are data in this engine, so add ` +
        `data/states/AL-${input.checkDate.slice(0, 4)}.json (with its source URL and verifiedOn date) ` +
        `rather than calculating against another year's rules`,
    );
  }

  // --- pay frequency ----------------------------------------------------
  const frequency = input.payFrequency;
  if (!frequency || !(frequency in PERIODS_PER_YEAR)) {
    problems.push(
      `payFrequency must be one of ${Object.keys(PERIODS_PER_YEAR).join(', ')}, got ${JSON.stringify(frequency)}`,
    );
  }

  // --- earnings ---------------------------------------------------------
  const e = input.earnings ?? {};
  const earnings: Earning[] = [];
  pushEarning(earnings, 'REG', 'regular', requireMoney(problems, 'earnings.regular', e.regular));
  pushEarning(earnings, 'OT', 'regular', requireMoney(problems, 'earnings.overtime', e.overtime));
  pushEarning(earnings, 'BONUS', 'supplemental', requireMoney(problems, 'earnings.bonus', e.bonus));
  pushEarning(earnings, 'COMM', 'supplemental', requireMoney(problems, 'earnings.commission', e.commission));
  pushEarning(earnings, 'IMPUTED', 'imputed', requireMoney(problems, 'earnings.imputed', e.imputed));
  pushEarning(earnings, 'REIMB', 'reimbursement', requireMoney(problems, 'earnings.reimbursement', e.reimbursement));
  pushEarning(
    earnings,
    'HOUSING',
    'housing_allowance',
    requireMoney(problems, 'earnings.housingAllowance', e.housingAllowance),
  );
  const severanceCents = requireMoney(problems, 'earnings.severance', e.severance);
  pushEarning(earnings, 'SEVERANCE', 'regular', severanceCents);

  for (const [i, extra] of (e.other ?? []).entries()) {
    if (!extra || typeof extra.code !== 'string' || extra.code.length === 0) {
      problems.push(`earnings.other[${i}].code must be a non-empty string`);
      continue;
    }
    if (!EARNING_CATEGORIES.includes(extra.category)) {
      problems.push(
        `earnings.other[${i}].category must be one of ${EARNING_CATEGORIES.join(', ')}, got ` +
          `${JSON.stringify(extra.category)}`,
      );
      continue;
    }
    pushEarning(
      earnings,
      extra.code,
      extra.category,
      requireMoney(problems, `earnings.other[${i}].amount`, extra.amount),
    );
  }

  // --- deductions -------------------------------------------------------
  const deductions: Deduction[] = [];
  for (const [i, d] of (input.deductions ?? []).entries()) {
    if (!d || typeof d.code !== 'string' || d.code.length === 0) {
      problems.push(`deductions[${i}].code must be a non-empty string`);
      continue;
    }
    const isPosttax = d.category === 'posttax';
    if (!isPosttax && !PRETAX_CATEGORIES.includes(d.category as PretaxCategory)) {
      problems.push(
        `deductions[${i}].category must be 'posttax' or one of ${PRETAX_CATEGORIES.join(', ')}, got ` +
          `${JSON.stringify(d.category)}`,
      );
      continue;
    }
    const amount = requireMoney(problems, `deductions[${i}].amount`, d.amount);
    if (amount > 0) {
      deductions.push({
        code: d.code,
        category: isPosttax ? null : (d.category as PretaxCategory),
        amount,
      });
    }
  }

  // --- Form A-4 ---------------------------------------------------------
  const a4 = input.a4 ?? {};
  const exemptionCode = a4.exemptionCode ?? '0';
  if (!A4_CODES.includes(exemptionCode)) {
    problems.push(
      `a4.exemptionCode must be one of ${A4_CODES.join(', ')} (Form A-4's own codes), got ` +
        `${JSON.stringify(a4.exemptionCode)}`,
    );
  }
  const dependents = a4.dependents ?? 0;
  if (!Number.isInteger(dependents) || dependents < 0) {
    problems.push(`a4.dependents must be a non-negative whole number, got ${JSON.stringify(a4.dependents)}`);
  }
  const additionalWithholding = requireMoney(problems, 'a4.additionalWithholding', a4.additionalWithholding);

  // --- residency --------------------------------------------------------
  const residency = input.residency ?? {};
  const residenceState = (residency.residenceState ?? 'AL').toUpperCase();
  if (!/^[A-Z]{2}$/.test(residenceState)) {
    problems.push(
      `residency.residenceState must be a two-letter state code, got ${JSON.stringify(residency.residenceState)}`,
    );
  }
  const isNonresident = residenceState !== 'AL';

  const days = residency.daysWorkedInAlabamaThisYear;
  if (days !== undefined && (!Number.isFinite(days) || days < 0)) {
    problems.push(`residency.daysWorkedInAlabamaThisYear must be a non-negative number, got ${JSON.stringify(days)}`);
  }

  const fraction = residency.alabamaWorkFraction;
  if (fraction !== undefined && (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)) {
    problems.push(
      `residency.alabamaWorkFraction must be greater than 0 and at most 1 (a share, not a percentage), got ` +
        `${JSON.stringify(fraction)}`,
    );
  }

  // --- employment category ---------------------------------------------
  const employmentCategory = input.employmentCategory ?? 'standard';
  if (!EMPLOYMENT_CATEGORIES.includes(employmentCategory)) {
    problems.push(
      `employmentCategory must be one of ${EMPLOYMENT_CATEGORIES.join(', ')}, got ` +
        `${JSON.stringify(input.employmentCategory)}`,
    );
  }

  // --- federal W-4 ------------------------------------------------------
  const w4 = input.federalW4 ?? {};
  const filingStatus = w4.filingStatus ?? 'single';
  if (!FILING_STATUSES.includes(filingStatus)) {
    problems.push(
      `federalW4.filingStatus must be one of ${FILING_STATUSES.join(', ')}, got ${JSON.stringify(w4.filingStatus)}`,
    );
  }

  // --- severance exemption ---------------------------------------------
  const sev = input.severanceExemption;
  const severanceRequested =
    sev?.exemptThisPeriod !== undefined
      ? requireMoney(problems, 'severanceExemption.exemptThisPeriod', sev.exemptThisPeriod)
      : severanceCents;
  if (sev && severanceRequested > severanceCents) {
    problems.push(
      `severanceExemption.exemptThisPeriod (${sev.exemptThisPeriod}) exceeds earnings.severance ` +
        `(${e.severance ?? 0}) — you cannot exempt severance that was not paid`,
    );
  }

  // --- employer ---------------------------------------------------------
  const employer = input.employer ?? {};
  if (
    employer.unemploymentRate !== undefined &&
    (!Number.isFinite(employer.unemploymentRate) ||
      employer.unemploymentRate < 0 ||
      employer.unemploymentRate > 1)
  ) {
    problems.push(
      `employer.unemploymentRate must be a decimal rate between 0 and 1 (0.031 for 3.1%), got ` +
        `${JSON.stringify(employer.unemploymentRate)}`,
    );
  }

  if (problems.length > 0) throw new AlabamaInputError(problems);

  // ---------------------------------------------------------------------
  // Everything below here runs only on a valid input.
  // ---------------------------------------------------------------------

  const rules = stateRuleset('AL', input.checkDate);

  // --- work city --------------------------------------------------------
  let matchedCity: { name: string; rate: number } | undefined;
  if (input.workCity) {
    const entry = alMunicipalityRuleset(input.workCity, input.checkDate);
    if (entry) {
      matchedCity = { name: entry.name, rate: entry.rate };
    } else {
      warnings.push(
        `No occupational tax is on file for "${input.workCity}", so no local line was computed. Most ` +
          `Alabama municipalities levy none at all, so this is usually correct — but the list this engine ` +
          `holds is built from the Alabama League of Municipalities' survey plus the collecting agents' own ` +
          `returns, not a state register (Alabama has none), and a city that adopted a tax without appearing ` +
          `in either would look identical to a city with no tax. Verify with the municipality if the answer matters.`,
      );
    }
  }

  const certificate: Record<string, unknown> = {
    alabamaExemptionCode: exemptionCode,
    dependents,
  };
  if (additionalWithholding > 0) certificate.additionalWithholding = additionalWithholding;
  if (a4.exempt) {
    certificate.exempt = true;
    if (a4.exemptReason) certificate.exemptReason = a4.exemptReason;
  }
  if (matchedCity) certificate.workCity = matchedCity.name;
  let matchedCounty: { name: string; rate: number } | undefined;
  if (input.workCounty) {
    const county = alCountyRuleset(input.workCounty, input.checkDate);
    if (county) {
      matchedCounty = { name: county.name, rate: county.rate };
      certificate.workCounty = county.name;
    }
  }
  if (isNonresident && days !== undefined) certificate.daysWorkedInStateThisYear = days;
  if (isNonresident && fraction !== undefined && fraction < 1) {
    certificate.nonresidentAllocationFraction = fraction;
  }
  if (severanceRequested > 0) {
    certificate.severanceExemptWages = severanceRequested;
    certificate.severanceApprovalOnFile = sev?.approvalOnFile === true;
    certificate.severanceExemptYtd = dollars(sev?.alreadyExemptedThisYear ?? 0);
  }

  const ytd = input.ytd ?? {};
  const engineInput: PaycheckInput = {
    checkDate: input.checkDate,
    payFrequency: frequency as PayFrequency,
    earnings,
    deductions,
    federalW4: {
      filingStatus,
      multipleJobs: w4.multipleJobs === true,
      dependentCredit: dollars(w4.dependentCredit ?? 0),
      otherIncome: dollars(w4.otherIncome ?? 0),
      deductions: dollars(w4.deductions ?? 0),
      extraWithholding: dollars(w4.extraWithholding ?? 0),
      ...(w4.exempt ? { exempt: true } : {}),
      ...(w4.nonresidentAlien ? { nonresidentAlien: true } : {}),
    },
    ytd: {
      socialSecurity: dollars(ytd.socialSecurity ?? 0),
      medicare: dollars(ytd.medicare ?? 0),
      futa: dollars(ytd.futa ?? 0),
      ...(ytd.supplemental !== undefined ? { supplemental: dollars(ytd.supplemental) } : {}),
      ...(ytd.categoryCashWages !== undefined
        ? { categoryCashWages: dollars(ytd.categoryCashWages) }
        : {}),
      ...(ytd.tier2Compensation !== undefined
        ? { tier2Compensation: dollars(ytd.tier2Compensation) }
        : {}),
      ...(ytd.railroadMonthlyCompensation !== undefined
        ? { railroadMonthlyCompensation: dollars(ytd.railroadMonthlyCompensation) }
        : {}),
      stateUnemployment: { AL: dollars(ytd.alabamaUnemployment ?? 0) },
    },
    employer: {
      ...(employer.unemploymentRate !== undefined
        ? { stateUnemploymentRate: { AL: employer.unemploymentRate } }
        : {}),
      ...(employer.useFivePercentSupplementalRate
        ? { supplementalFlatRateElection: { AL: true } }
        : {}),
      ...(employer.householdQuarterlyCashWages !== undefined
        ? { householdQuarterlyCashWages: dollars(employer.householdQuarterlyCashWages) }
        : {}),
      ...(employer.agriculturalTotalWages !== undefined
        ? { agriculturalTotalWages: dollars(employer.agriculturalTotalWages) }
        : {}),
      ...(employer.agriculturalFutaLiable !== undefined
        ? { agriculturalFutaLiable: employer.agriculturalFutaLiable }
        : {}),
      ...(employer.railroadUnemploymentRate !== undefined
        ? { railroadUnemploymentRate: employer.railroadUnemploymentRate }
        : {}),
    },
    ...(employmentCategory !== 'standard' ? { employmentCategory } : {}),
    workState: { code: 'AL', certificate },
    residenceState: { code: residenceState },
    ...(input.options?.roundToWholeDollars ? { roundToWholeDollars: true } : {}),
  };

  warnings.push(...advisoryWarnings(input, { isNonresident, days, severanceCents, rules }));

  return { engineInput, warnings, a4: { exemptionCode, dependents }, matchedCity, matchedCounty };
}

/**
 * Warnings, not errors: every one of these describes a cheque this engine
 * will happily compute, and a reason a reviewer might want to look at the
 * result before it goes out the door. Silence would be the worse choice in
 * each case — they are exactly the situations where the arithmetic is right
 * and the ANSWER is arguable.
 */
function advisoryWarnings(
  input: AlabamaPaycheckInput,
  ctx: {
    isNonresident: boolean;
    days: number | undefined;
    severanceCents: Cents;
    rules: ReturnType<typeof stateRuleset>;
  },
): string[] {
  const out: string[] = [];
  const e = input.earnings ?? {};
  const supplemental = (e.bonus ?? 0) + (e.commission ?? 0);
  const regularCash = (e.regular ?? 0) + (e.overtime ?? 0) + (e.severance ?? 0);
  const elected = input.employer?.useFivePercentSupplementalRate === true;

  if (supplemental > 0 && regularCash === 0 && !elected) {
    out.push(
      `This cheque is supplemental wages only (no regular pay) and the employer has not elected Alabama's ` +
        `flat 5% method, so the bonus is being run through the ordinary formula — which annualizes it as ` +
        `though the employee earned that amount EVERY pay period, and therefore over-withholds. Alabama's ` +
        `booklet offers the 5% flat rate for exactly this case: set employer.useFivePercentSupplementalRate. ` +
        `Alabama publishes no aggregate-with-the-last-regular-cheque instruction, so this engine does not ` +
        `invent one.`,
    );
  }

  if (ctx.isNonresident && ctx.days === undefined) {
    out.push(
      `Employee is a ${input.residency?.residenceState} resident, and no day count was supplied, so Alabama ` +
        `tax WAS withheld. Act 2025-334's safe harbor exempts a nonresident who works 30 or fewer days in ` +
        `Alabama in the calendar year — set residency.daysWorkedInAlabamaThisYear if you track it. An absent ` +
        `count is deliberately treated as "withhold", never as "few days".`,
    );
  }

  if (ctx.isNonresident && input.residency?.alabamaWorkFraction === undefined && ctx.days !== undefined && ctx.days > 30) {
    out.push(
      `Employee is a nonresident past the 30-day safe harbor and no residency.alabamaWorkFraction was given, ` +
        `so this entire cheque was treated as Alabama-earned. Alabama taxes a nonresident "only on wages ` +
        `earned in Alabama" — if part of this period's work happened elsewhere, supply the fraction.`,
    );
  }

  if (ctx.severanceCents > 0 && input.severanceExemption?.approvalOnFile !== true) {
    out.push(
      `Severance was paid and taxed as ordinary wages. Alabama exempts up to $50,000 of severance or ` +
        `termination pay from an administrative downsizing, but only after the employer obtains the ` +
        `Department of Revenue's approval — set severanceExemption.approvalOnFile once you have it.`,
    );
  }

  if ((e.housingAllowance ?? 0) > 0 && input.employmentCategory !== 'clergy') {
    out.push(
      `A housing allowance was paid to a worker whose employmentCategory is not 'clergy', so it was taxed as ` +
        `ordinary wages. The parsonage exclusion belongs to ministers; a naming convention is not an ` +
        `exemption.`,
    );
  }

  if (input.employer?.unemploymentRate === undefined) {
    const newRate = (ctx.rules.suiEmployer as { newEmployerRate?: number } | undefined)?.newEmployerRate;
    out.push(
      `No employer.unemploymentRate was supplied, so Alabama's published new-employer rate ` +
        `(${newRate !== undefined ? `${(newRate * 100).toFixed(2)}%` : 'as published'}) was used for the ` +
        `employer unemployment line. Every established employer has its own experience-rated figure from the ` +
        `Alabama Department of Labor — supply it, or the employer cost on this cheque is an estimate.`,
    );
  }

  if (!input.ytd || Object.keys(input.ytd).length === 0) {
    out.push(
      `No year-to-date figures were supplied, so every wage-base-capped tax was computed as though this were ` +
        `the employee's first cheque of the year: Social Security ($184,500 base), FUTA ($7,000) and Alabama ` +
        `unemployment ($8,000 — small, and reached quickly). Correct for a January cheque and wrong for any ` +
        `other.`,
    );
  }

  if ((e.overtime ?? 0) > 0) {
    out.push(
      `Overtime was taxed as ordinary Alabama wages. That is correct for 2026 — Act 2023-421's overtime ` +
        `exclusion ended 2025-06-30 — and it is the opposite of what an Alabama payroll did in 2024 and the ` +
        `first half of 2025, so it is worth confirming that any comparison figure you are checking against ` +
        `is from after the expiry.`,
    );
  }

  return out;
}
