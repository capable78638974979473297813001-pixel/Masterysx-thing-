import type { Cents } from '../money.ts';
import type {
  EmploymentCategory,
  FilingStatus,
  PayFrequency,
  PretaxCategory,
  TaxLine,
} from '../types.ts';

/**
 * The Alabama input/output surface.
 *
 * The engine's own PaycheckInput is deliberately national and deliberately
 * low-level: integer cents, a federal W-4 in full, and a `certificate` bag
 * whose shape changes state by state. That is the right shape for the
 * engine and the wrong shape for someone who has an Alabama payroll to run
 * and an Alabama Form A-4 in front of them.
 *
 * So this layer is the Alabama one: dollars instead of cents, the A-4's own
 * five exemption codes instead of a free-form certificate, a work city
 * instead of a local-tax lookup key, and — the part that matters most — a
 * set of validations and warnings that know what Alabama actually does.
 * Everything here converts down to PaycheckInput and calls the same
 * calculatePaycheck() every other state uses; nothing here re-implements a
 * tax.
 *
 * MONEY IS IN DOLLARS at this boundary (3218.50, not 321850), because these
 * inputs are written by hand and read by people. It becomes cents on the
 * way in, once, in input.ts, and comes back out as all three
 * representations so nothing downstream has to guess which one it is
 * holding.
 */

/** Dollars, as written on a pay statement. Converted to cents on entry. */
export type Dollars = number;

/**
 * Form A-4's exemption codes, exactly as the form prints them.
 *
 *   '0'  — claiming no personal exemption
 *   'S'  — single, one personal exemption ($1,500)
 *   'MS' — married filing separately, own exemption only ($1,500)
 *   'M'  — married, claiming both spouses' exemptions ($3,000). The only
 *          code that gets Alabama's WIDER bracket schedule.
 *   'H'  — head of family ($3,000)
 *
 * An employee with no A-4 on file is not an error and does not need a
 * default invented for them: the booklet says "the employer should withhold
 * using zero exemptions," so an absent certificate is treated as '0' with
 * no dependents.
 */
export type A4ExemptionCode = '0' | 'S' | 'MS' | 'M' | 'H';

/** Form A-4, Employee's Withholding Tax Exemption Certificate. */
export interface AlabamaA4 {
  /** Lines 1-3: the exemption code the employee claimed. Default '0'. */
  exemptionCode?: A4ExemptionCode;
  /** Line 4: dependents other than the spouse. */
  dependents?: number;
  /** Line 5: additional amount to deduct each pay period, in dollars. */
  additionalWithholding?: Dollars;
  /**
   * The employee owes no Alabama withholding at all. Alabama recognises
   * several distinct exemptions that all arrive here as one boolean — the
   * four federal-law ones (air carrier, interstate carrier, water carrier,
   * military spouse under Form A4-MS) plus merchant seamen — so say WHICH
   * in `exemptReason`; it is carried into the tax line's own detail and
   * onto the explanation section of the output.
   *
   * Eligibility is the employer's determination, never this engine's.
   */
  exempt?: boolean;
  exemptReason?: string;
}

/** The employee's federal Form W-4 (2020 or later). Dollars, not cents. */
export interface AlabamaFederalW4 {
  filingStatus?: FilingStatus;
  /** Step 2 checkbox. */
  multipleJobs?: boolean;
  /** Step 3 annual credit. */
  dependentCredit?: Dollars;
  /** Step 4(a). */
  otherIncome?: Dollars;
  /** Step 4(b). */
  deductions?: Dollars;
  /** Step 4(c), per pay period. */
  extraWithholding?: Dollars;
  exempt?: boolean;
  nonresidentAlien?: boolean;
}

/**
 * Where the employee lives and how much of this period's work happened in
 * Alabama. Both facts are Alabama-relevant for the same reason: Alabama
 * taxes a nonresident only on wages earned in Alabama, and Act 2025-334
 * exempts one entirely below 31 days a year.
 */
export interface AlabamaResidency {
  /**
   * 'AL' (the default) or the two-letter code of the state the employee
   * actually lives in. Naming another state is what turns on both the
   * 30-day safe harbor and the in-state allocation below.
   */
  residenceState?: string;
  /**
   * Days this employee has worked in Alabama so far this calendar year.
   * At or below 30, a nonresident is exempt under Act 2025-334's safe
   * harbor. LEAVING THIS OUT MEANS WITHHOLD: an unknown day count is not a
   * claim of a small one.
   */
  daysWorkedInAlabamaThisYear?: number;
  /**
   * The share of this period's services performed in Alabama, 0-1, for a
   * nonresident who split the period across states. Only applies to a
   * nonresident; absent, the whole cheque is treated as Alabama-earned.
   */
  alabamaWorkFraction?: number;
}

/** One earning line, when the named buckets below aren't enough. */
export interface AlabamaEarning {
  code: string;
  /**
   * 'regular' | 'supplemental' | 'imputed' | 'reimbursement' |
   * 'housing_allowance' — the engine's own categories, because what
   * separates them is tax treatment, not naming.
   */
  category: 'regular' | 'supplemental' | 'imputed' | 'reimbursement' | 'housing_allowance';
  amount: Dollars;
}

/**
 * What the employee was paid this period. The named fields cover the
 * ordinary cases; `other` takes anything else.
 *
 * OVERTIME IS ORDINARY TAXABLE PAY and is a named field only because
 * Alabama spent eighteen months where it wasn't: Act 2023-421 excluded it
 * from state income tax from 2024-01-01, and that exclusion ended
 * 2025-06-30. For any 2026 cheque, overtime is regular wages. The field
 * exists so a payroll that tracks overtime separately can keep doing so and
 * still get the right answer.
 */
export interface AlabamaEarnings {
  regular?: Dollars;
  overtime?: Dollars;
  /** Taxed as supplemental — matters if the employer elects the 5% method. */
  bonus?: Dollars;
  /** Also supplemental. */
  commission?: Dollars;
  /** Taxable but not paid in cash, e.g. group term life over $50,000. */
  imputed?: Dollars;
  /** Paid in cash, not taxable. */
  reimbursement?: Dollars;
  /** A minister's designated housing allowance. Only excluded for clergy. */
  housingAllowance?: Dollars;
  /**
   * Severance, termination pay, or supplemental-income-plan pay from an
   * administrative downsizing. Taxable like any other wages UNLESS the
   * employer has the Department of Revenue's approval — see
   * `severanceExemption` below. Paid in cash either way.
   */
  severance?: Dollars;
  other?: AlabamaEarning[];
}

export interface AlabamaDeduction {
  code: string;
  /** A pre-tax category, or 'posttax' for one that reduces only net pay. */
  category: PretaxCategory | 'posttax';
  amount: Dollars;
}

/**
 * Alabama's $50,000 severance exemption. Conditional on an approval this
 * engine cannot see and capped per employee rather than per cheque, so both
 * facts come from the caller.
 */
export interface AlabamaSeveranceExemption {
  /** The Department of Revenue has approved this employer's exemption. */
  approvalOnFile: boolean;
  /** How much of the $50,000 earlier cheques already used, in dollars. */
  alreadyExemptedThisYear?: Dollars;
  /**
   * How much of THIS period's severance to exempt, in dollars. Defaults to
   * all of `earnings.severance`.
   */
  exemptThisPeriod?: Dollars;
}

/** Year-to-date figures, in dollars. Every wage-capped tax needs these. */
export interface AlabamaYearToDate {
  socialSecurity?: Dollars;
  medicare?: Dollars;
  futa?: Dollars;
  /** Alabama unemployment wages so far — the $8,000 base is small and bites early. */
  alabamaUnemployment?: Dollars;
  /** Supplemental wages paid this year, for the federal $1M rule. */
  supplemental?: Dollars;
  /**
   * Cash wages paid to THIS household or agricultural worker so far this
   * year. Federal FICA turns on it ($3,000 for household, $150 for a
   * farmworker) — Alabama's own withholding does not, since it excludes
   * both classes outright. Only meaningful with a matching
   * employmentCategory.
   */
  categoryCashWages?: Dollars;
  /** Railroad only: compensation already counted toward the Tier II base. */
  tier2Compensation?: Dollars;
  /** Railroad only: RUIA compensation THIS CALENDAR MONTH — RUIA caps monthly. */
  railroadMonthlyCompensation?: Dollars;
}

export interface AlabamaEmployer {
  name?: string;
  /**
   * This employer's own assigned Alabama unemployment contribution rate
   * (0.031 for 3.1%). Alabama's experienced range runs 0.20%-6.80%. Absent,
   * the published 2.7% new-employer rate is used and the line says so.
   */
  unemploymentRate?: number;
  /**
   * Elect Alabama's flat 5% method for bonuses and other supplemental
   * wages. The booklet says employers MAY do this, so nothing happens until
   * the employer says so.
   */
  useFivePercentSupplementalRate?: boolean;
  /**
   * Cash wages paid to ALL household employees this calendar quarter — the
   * federal $1,000 FUTA test for domestic employment. Employer-wide, so
   * only the employer has it.
   */
  householdQuarterlyCashWages?: Dollars;
  /** Wages paid to ALL farmworkers this year — the federal $2,500 test. */
  agriculturalTotalWages?: Dollars;
  /** Whether this employer meets the agricultural FUTA test outright. */
  agriculturalFutaLiable?: boolean;
  /** Railroad only: this employer's own experience-rated RUIA rate. */
  railroadUnemploymentRate?: number;
}

export interface AlabamaOptions {
  /**
   * Round each withholding amount to whole dollars, which the booklet
   * permits for the formula method. Off by default: cent-level withholding
   * is what ties out against a penny-accurate quarterly return.
   */
  roundToWholeDollars?: boolean;
}

/** One Alabama paycheck, as a person would describe it. */
export interface AlabamaPaycheckInput {
  /** ISO yyyy-mm-dd. Decides which year's rules apply — never "today". */
  checkDate: string;
  payFrequency: PayFrequency;
  employeeName?: string;
  earnings: AlabamaEarnings;
  deductions?: AlabamaDeduction[];
  a4?: AlabamaA4;
  federalW4?: AlabamaFederalW4;
  residency?: AlabamaResidency;
  /**
   * The Alabama municipality where the work was performed. Alabama's
   * occupational tax is work-location-based; 29 municipalities are known to
   * levy one and most other cities do not. An unrecognised name produces
   * no local line and a warning — never a silent $0.
   */
  workCity?: string;
  /**
   * The county where the work was performed. Only Macon County levies a
   * county-level occupational fee (1%, Ala. Code 45-44-244.31), and only
   * outside Tuskegee, Notasulga and Shorter; any other county is ignored.
   */
  workCounty?: string;
  /**
   * Which body of employment-tax rules applies. Alabama excludes
   * 'household', 'agricultural' and 'clergy' from its own withholding
   * entirely — including agricultural, which the federal rules DO tax once
   * their own thresholds are met.
   */
  employmentCategory?: EmploymentCategory;
  severanceExemption?: AlabamaSeveranceExemption;
  ytd?: AlabamaYearToDate;
  employer?: AlabamaEmployer;
  options?: AlabamaOptions;
}

/** One money figure, in every representation a caller might want. */
export interface Amount {
  cents: Cents;
  dollars: number;
  display: string;
}

export interface AlabamaTaxLineOutput {
  id: string;
  name: string;
  payer: 'employee' | 'employer';
  jurisdiction: 'federal' | 'state' | 'local';
  taxableWages: Amount;
  amount: Amount;
  /** How the number was reached, in words. Straight from the engine. */
  detail: string;
}

export interface AlabamaPaycheckOutput {
  checkDate: string;
  payFrequency: PayFrequency;
  periodsPerYear: number;
  employeeName?: string;
  employerName?: string;

  grossPay: Amount;
  /**
   * The base ALABAMA INCOME TAX was computed on, after its own pre-tax
   * exclusions. Deliberately not called "taxable gross": there is no single
   * taxable gross on a paycheck. The same 401(k) dollar leaves the Alabama
   * and federal income tax bases and stays in the Social Security base, so
   * three taxes on this cheque are measured against three different
   * numbers — each tax line carries its own in `taxableWages`.
   */
  alabamaTaxableWages: Amount;
  pretaxDeductions: Amount;
  posttaxDeductions: Amount;

  employeeTaxes: AlabamaTaxLineOutput[];
  employerTaxes: AlabamaTaxLineOutput[];
  employeeTaxTotal: Amount;
  employerTaxTotal: Amount;
  netPay: Amount;
  /** Gross plus every employer-borne tax — what this cheque costs to write. */
  employerCost: Amount;

  /** The Alabama-specific view: what was applied and why. */
  alabama: {
    stateIncomeTax: Amount;
    /** Present only when the work city levies an occupational tax. */
    localOccupationalTax?: { city: string; rate: number; amount: Amount };
    /** Present only when the work is in Macon County outside its three taxing towns. */
    countyOccupationalTax?: { county: string; rate: number; amount: Amount };
    unemploymentEmployer?: Amount;
    a4: { exemptionCode: A4ExemptionCode; dependents: number; bracketSchedule: 'M' | 'non-M' };
    /** Plain-language account of every Alabama rule that touched this cheque. */
    explanation: string[];
  };

  /**
   * Things that are true, calculated, and worth knowing anyway — a
   * standalone bonus cheque taxed by annualization, a work city with no
   * occupational tax on file, a nonresident with no day count supplied. The
   * cheque is still computed; these say what a reviewer should look at.
   */
  warnings: string[];

  /** The engine's own lines, untouched, for anything this shape omits. */
  raw: TaxLine[];
}
