import type { Cents } from './money.ts';

export type FilingStatus =
  | 'single'
  | 'married_joint'
  | 'married_separate'
  | 'head_of_household';

export type PayFrequency =
  | 'weekly'
  | 'biweekly'
  | 'semimonthly'
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual'
  | 'daily';

export const PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
  daily: 260,
};

/**
 * Categories of pre-tax deduction.
 *
 * This enumeration is the spine of the whole engine. Every tax declares which
 * of these categories actually reduce ITS taxable base, because the same
 * dollar of deferral is exempt from one tax and fully taxable under another.
 * Getting this table wrong is the single most common defect in home-grown
 * payroll systems — the gross-to-net arithmetic is trivial by comparison.
 */
export type PretaxCategory =
  | 'section125' // cafeteria plan: medical/dental/vision premiums
  | 'hsa' // health savings account (via cafeteria plan)
  | 'fsa' // health flexible spending
  | 'dependent_care' // dependent care assistance
  | 'deferral_401k'
  | 'deferral_403b'
  | 'deferral_457'
  | 'deferral_simple'
  | 'commuter'; // qualified transportation fringe

export type EarningCategory =
  | 'regular'
  | 'supplemental' // bonus, commission — may use flat supplemental rate
  | 'imputed' // taxable but not paid in cash (e.g. group term life > $50k)
  | 'reimbursement' // paid in cash but not taxable
  /**
   * A minister's designated housing (parsonage) allowance: paid in cash and
   * excluded from income tax, but included in the minister's own
   * self-employment tax base. Only excluded from tax when the worker is
   * employmentCategory 'clergy' — a housing allowance paid to anyone else
   * is ordinary taxable pay, and treating it otherwise would be a way to
   * make wages disappear.
   */
  | 'housing_allowance';

export interface Earning {
  code: string;
  category: EarningCategory;
  amount: Cents;
  /**
   * Pay for hours worked over 40 in a week. Only a state rule that
   * excludes overtime reads it (Alabama, 2024-01-01 through 2025-06-30);
   * everywhere else overtime is ordinary wages of its category.
   */
  overtime?: boolean;
}

export interface Deduction {
  code: string;
  /** `null` means post-tax — reduces net pay but no taxable base. */
  category: PretaxCategory | null;
  amount: Cents;
}

/** Employee's Form W-4 (2020 or later revision). */
export interface FederalW4 {
  filingStatus: FilingStatus;
  /** Step 2 checkbox: two jobs / spouse works. */
  multipleJobs: boolean;
  /** Step 3: annual credit amount in dollars, as entered by employee. */
  dependentCredit: Cents;
  /** Step 4(a): other annual income. */
  otherIncome: Cents;
  /** Step 4(b): annual deductions beyond the standard deduction. */
  deductions: Cents;
  /** Step 4(c): additional withholding per pay period. */
  extraWithholding: Cents;
  /** Employee claimed exempt from federal withholding. */
  exempt?: boolean;
  /**
   * Employee is a nonresident alien performing services within the US —
   * triggers Pub 15-T's "Withholding Adjustment for Nonresident Alien
   * Employees" procedure (add a fixed per-period dollar amount to wages
   * before the ordinary percentage-method calculation runs). Does NOT apply
   * to nonresident alien students/business apprentices from India, who Pub
   * 15-T explicitly carves out of this procedure — the caller is
   * responsible for that carve-out, same as every other eligibility
   * determination this engine trusts the input for.
   */
  nonresidentAlien?: boolean;
  /**
   * A voluntary income tax withholding agreement, the one way a minister's
   * pay carries federal income tax withholding at all (IRS: an employer and
   * minister MAY agree to withhold, reported in box 2 of the W-2). Ignored
   * for every other employment category.
   */
  voluntaryWithholdingAgreement?: boolean;
}

/** Year-to-date wages, needed for every wage-base-capped tax. */
export interface YearToDate {
  /** YTD wages subject to Social Security. */
  socialSecurity: Cents;
  /** YTD wages subject to Medicare (also drives Additional Medicare). */
  medicare: Cents;
  /** YTD wages subject to FUTA. */
  futa: Cents;
  /**
   * YTD supplemental wages paid this calendar year. Drives the mandatory 37%
   * federal rate once cumulative supplemental wages pass $1,000,000. Optional;
   * absent means none so far this year.
   */
  supplemental?: Cents;
  /** YTD wages per state unemployment, keyed by state code. */
  stateUnemployment?: Record<string, Cents>;
  /**
   * Cash wages paid to THIS household or agricultural worker so far this
   * year, which is what the coverage tests measure. Not the same as the
   * social security YTD figure above: that one counts wages already
   * subjected to the tax, while this counts wages paid whether or not they
   * were taxable yet — the whole question being when they become taxable.
   */
  categoryCashWages?: Cents;
  /**
   * YTD compensation already counted toward the railroad retirement Tier II
   * wage base. A separate tracker from socialSecurity because Tier II caps
   * far lower ($137,100 for 2026 against $184,500), so the two run out at
   * different points in the year.
   */
  tier2Compensation?: Cents;
  /**
   * Compensation already counted toward the railroad unemployment (RUIA)
   * base THIS CALENDAR MONTH. RUIA caps monthly rather than annually
   * ($2,150 a month for 2026), so unlike every other tracker here it
   * resets twelve times a year and the caller keeps it.
   */
  railroadMonthlyCompensation?: Cents;
  /**
   * This employee's Seattle compensation so far this year. Seattle's
   * payroll expense tax bands by ANNUAL compensation, so a cheque cannot be
   * placed in a band without knowing what came before it.
   */
  seattleCompensation?: Cents;
  /**
   * YTD wages already counted toward a state Paid Family & Medical Leave
   * wage-base cap, keyed by state code (e.g. Minnesota Paid Leave). Separate
   * tracker from stateUnemployment even where a state has both, since the
   * two levies cap at different wage bases under different statutes.
   */
  statePaidLeave?: Record<string, Cents>;
  /**
   * YTD wages already counted toward a state disability insurance wage-base
   * cap, keyed by state code (e.g. New Jersey TDI). Only used by the
   * annual-wage-base variant of stateDisabilityEmployeeTax() — New York's DBL
   * uses a per-period dollar cap instead and never reads this.
   */
  stateDisabilityEmployee?: Record<string, Cents>;
  /**
   * YTD wages already counted toward a state long-term-care insurance
   * wage-base cap, keyed by state code (e.g. Washington's WA Cares Fund).
   * Separate tracker from statePaidLeave even where a state has both (WA
   * does — Paid Leave and WA Cares are different statutes with different
   * caps, WA Cares uncapped and Paid Leave sharing the SS wage base).
   */
  stateLongTermCare?: Record<string, Cents>;
  /**
   * YTD wages already counted toward a LOCAL income tax's withholding
   * TRIGGER (not a wage-base cap — these are threshold-based: no tax at
   * all below the threshold, then a flat rate on wages above it, forever,
   * not just the first dollar past the line). Keyed by an arbitrary
   * per-locality id chosen by that locality's own dispatch function (e.g.
   * 'OR_METRO', 'OR_MULTNOMAH' for Portland's Metro Supportive Housing
   * Services and Multnomah County Preschool For All taxes) rather than by
   * state code, since a single state can have multiple independent local
   * triggers active at once. Also YTD district wages for local taxes with an
   * annual wage CAP: Kentucky's SS-wage-base-capped cities ('KY_LOCAL_<name>')
   * and Ohio's capped JEDDs ('OH_JEDD_<jeddId>').
   */
  localIncomeTax?: Record<string, Cents>;
  /**
   * YTD elective-deferral contributions already made to THIS employer's
   * plan(s) so far this calendar year — what capElectiveDeferrals() (see
   * wages.ts) checks against the IRC annual limits before letting this
   * period's 401(k)/403(b)/457/SIMPLE deduction count as pretax. Grouped
   * the way the law actually aggregates them: section402gAggregate covers
   * 401(k)+403(b) combined (one shared limit); deferral457 and simple are
   * each their own separate limit, tracked independently. Does NOT — and
   * cannot — reflect contributions at a different employer earlier in the
   * year; see this engine's own disclosed single-employer-visibility
   * limitation (same class as the Social Security/FUTA wage-base trackers
   * above).
   */
  electiveDeferrals?: {
    section402gAggregate?: Cents;
    deferral457?: Cents;
    simple?: Cents;
  };
}

/**
 * Every field any state or local tax in src/taxes/state.ts reads off
 * workState.certificate / residenceState.certificate, gathered from that
 * file's own certificate.* reads so a caller can discover what a
 * jurisdiction needs from the type system instead of grepping state.ts.
 *
 * Several names here are reused across many states for the same KIND of
 * fact (maritalStatus, filingStatus, withholdingCode, formVintage) but each
 * state accepts its own, different set of values for it — e.g. NJ's
 * filingStatus is 'single'|'mfs'|'mfj'|'hoh'|'qw' while MD's is
 * 'single'|'mfjHoh'. Typed as `string` for those rather than one union that
 * would wrongly suggest every state accepts every other state's values;
 * stateIncomeTax() validates the actual per-state set at runtime and throws
 * a clear "Unrecognized <STATE> certificate.<field>" error naming exactly
 * what that state accepts. Fields confirmed to have one fixed, state-wide
 * set of values (e.g. Alabama's exemption code, MA's M-4 codes) keep that
 * literal union.
 *
 * The index signature is a forward-compatibility escape hatch, not an
 * invitation to skip adding a field here: a genuinely new certificate
 * field should be added above it, the same way a new StateRuleset field is
 * added to that interface rather than left to the index signature there.
 */
export interface StateCertificate {
  // --- geography (usually set by geocode/'s toCertificateFields(), not by
  // hand) ---
  /** Caller-resolved locality name for a caller-resolved-locality tax (Newark, Kansas City/St. Louis, Wilmington, Seattle, Denver/Glendale/Greenwood Village/Sheridan/Aurora, WV's service-fee cities, OR's transit districts). */
  locality?: string;
  /** County name — Indiana's mandatory county tax, Maryland's county piggyback tax, Kentucky's county-role occupational tax. */
  county?: string;
  /**
   * Arkansas AR4EC Line 5: the employee elected DFA's Low Income Tax Tables.
   * Requires certificate.filingStatus ('single' | 'mfj' | 'hoh') and
   * certificate.dependents. Above the tables' top band the Formula Method
   * applies; daily pay and 7+ dependents (not in DFA's tables) also use the
   * Formula Method, with a notice.
   */
  lowIncomeElection?: boolean;
  /** WORK-address county: Kentucky's county-role occupational tax (city-vs-county credit) and Alabama's Macon County occupational fee. Never a residence concept. */
  workCounty?: string;
  /** City name — Michigan/Ohio/Alabama/Kentucky city-level local income tax, work role. */
  workCity?: string;
  /** Residence county (Kentucky: a Jefferson County resident pays Louisville Metro's resident rate wherever in the county they live). */
  residenceCounty?: string;
  /** City name — same registries as workCity, residence role (Michigan/Ohio/Alabama/Kentucky, plus NYC/Yonkers logic reads it for the "is the other address also this city" check). */
  residenceCity?: string;
  /** Pennsylvania's 6-digit work PSD code (required whenever PA local tax applies). */
  workPSD?: string;
  /** Pennsylvania's 6-digit residence PSD code; absent or '88000' means out-of-state/unknown residence. */
  residencePSD?: string;
  /** Ohio's 4-digit School District Income Tax code. */
  schoolDistrictCode?: string;
  /** Ohio's own JEDD/JEDZ zone id (not a name). */
  workJEDDId?: string;

  // --- NYC / Yonkers (New York) ---
  nycResident?: boolean;
  yonkersResident?: boolean;
  yonkersNonresidentWorker?: boolean;
  /** NYS-50-T-NYC Line 1 fallback when unset: this employee's NYC exemption count. */
  nycExemptions?: number;
  additionalWithholdingNYC?: Cents;
  additionalWithholdingYonkers?: Cents;

  // --- Oregon / Portland ---
  metroDistrict?: boolean;
  multnomahCounty?: boolean;

  // --- caller-resolved-locality tax facts no address can supply ---
  /** This month's cumulative pay so far in the locality — Denver-family OPT, Seattle JumpStart-adjacent monthly tests. */
  localMonthlyCompensation?: Cents;
  /** True when this month's local flat-rate/head tax was already withheld this cheque period, so it isn't withheld twice. */
  localOPTWithheldThisMonth?: Cents;
  /** Form TD269-style cross-employer coordination: true when a different employer already withheld this locality's employee OPT this month. */
  localOPTEmployeeWithheldByOtherEmployer?: boolean;
  /** This month's state tax already withheld so far — Denver-style monthly head-tax tests read this the same way. */
  stateTaxWithheldThisMonth?: Cents;
  /** West Virginia municipal service fee: proof it was already withheld elsewhere this period. */
  wvLocalFeeAlreadyWithheld?: boolean;
  /** Cumulative days worked in the locality/municipality this year — WV service-fee minimum-days gates, PA's day-count apportionment. */
  daysWorkedInLocality?: number;
  daysWorkedInMunicipality?: number;
  /** Default true — most employees have exactly one work municipality; set false only for a genuinely split work location. */
  workCityIsPrincipalWorkplace?: boolean;
  /** Newark: this employee's wages are excluded from the employer's resident-apportionment calculation (the employer's own workforce-wide determination). */
  newarkResidentApportionmentExcluded?: boolean;
  /** Pennsylvania LST: proof another employer already withheld it this year, so this employer doesn't withhold it again past the annual cap. */
  lstAlreadyWithheldElsewhere?: boolean;

  // --- reciprocity / multi-state ---
  /** Caller asserts this reciprocal-state employee is a genuine daily commuter, where a state's reciprocity is commuter-only. */
  dailyCommuter?: boolean;
  /** Caller asserts the further statutory conditions a paycheck alone can't evidence for a nonresident de minimis exemption. */
  nonresidentDeMinimisEligible?: boolean;
  /** Caller asserts this nonresident qualifies for a resident-state tax credit, where that eligibility gates the exemption. */
  nonresidentCreditEligible?: boolean;
  /** Cumulative days worked in the state this year — Indiana's 30-day rule and similar day-count thresholds. */
  daysWorkedInStateThisYear?: number;
  /** Direct nonresident flag some states' own forms use instead of a residence-state comparison (Maryland's county tax, Delaware's severance rules). */
  nonresident?: boolean;

  // --- exemption / withholding-adjustment mechanics generic across most states ---
  /** Employee claimed exempt from this state's withholding on their certificate. */
  exempt?: boolean;
  /** Free-text reason the caller is asserting for `exempt` — carried through to the emitted TaxLine detail, not validated. */
  exemptReason?: string;
  /** Flat extra dollar amount withheld per period on top of the computed tax (this state's own Line 4(c)-equivalent). */
  additionalWithholding?: Cents;
  /** Caller-computed reduced withholding amount, already capped correctly by the caller; floored at $0 against the computed tax. */
  reducedWithholding?: Cents;
  /** Employee/payee is a nonresident alien — forces the single/no-allowances schedule some states' forms require regardless of actual marital status (mirrors federalW4.nonresidentAlien for state purposes). */
  nonresidentAlien?: boolean;
  /** An employer and employee's voluntary state withholding agreement where the category (e.g. clergy) otherwise has none. */
  voluntaryWithholdingAgreement?: boolean;
  /** Personal/dependency allowance count on this state's own W-4-equivalent (PA/MI/KY-family flatRate() states, Maine, North Carolina, and others using the same allowanceAmount × count shape). */
  allowances?: number;
  /** NY/NJ-style raw exemption count (distinct from `allowances` in the states that use this name instead). */
  exemptions?: number;
  /** Iowa/Pennsylvania-adjacent "caller supplies the already-computed number" allowance figure (Iowa's 2024+ IA W-4 Line 7 total dollar allowance amount). */
  totalAllowanceAmount?: Cents;
  /** Kansas-adjacent count of additional personal allowances distinct from the base `allowances` count. */
  personalAllowances?: number;
  /** Which revision of a state's own withholding form/method applies — currently only Iowa's 'pre_2024' (pre-2024 IA W-4); absent means the current form. */
  formVintage?: string;
  /** Iowa pre-2024 W-4's own flag: whether the spouse also has earned income, which changes the applicable bracket. */
  spouseHasEarnedIncome?: boolean;
  /** Dependent count some states' own forms ask for directly (e.g. Massachusetts Form M-4 Line 4). */
  dependents?: number;
  /** Maine-only: this pay period's wages (in cents) sourced from tribal land, excluded from Maine's taxable base directly. */
  exemptWages?: Cents;

  // --- state-specific enumerated fields (each state validates its OWN
  // accepted set at runtime; see stateIncomeTax()'s own "Unrecognized
  // <STATE> certificate.<field>" errors for the authoritative list) ---
  /** Reused across many states for that state's own marital-status categories (e.g. WI/OR/ND 'single'|'married'; NY, MT, ID, IA, ME each with their own set). */
  maritalStatus?: string;
  /** Reused across many states for that state's own filing-status categories (e.g. NJ 'single'|'mfs'|'mfj'|'hoh'|'qw'; MD 'single'|'mfjHoh'; OK 'single'|'married'|'married_withhold_as_single'). */
  filingStatus?: string;
  /** Hawaii's own marital-status set — kept separate from `maritalStatus` because Hawaii doesn't allow the ordinary certificate.exempt-style exemption these other states share. */
  hawaiiMaritalStatus?: string;
  /** Connecticut Form CT-W4's own withholding code. */
  withholdingCode?: string;
  /** Kansas Form K-4's own allowance-rate election. */
  allowanceRate?: 'single' | 'joint';
  /** New Jersey NJ-W4's own Rate Table election — the only way NJ's alternate rate tables are ever selected. */
  rateTableOverride?: 'A' | 'B' | 'C' | 'D' | 'E';
  /** Massachusetts Form M-4 Line 1: 0 (no certificate on file), 1, or 2 (age 65+). */
  personalExemptionCode?: 0 | 1 | 2;
  /** Massachusetts Form M-4 Line 2: 0 (no spouse exemption), 4, or 5 (spouse age 65+). */
  spouseExemptionCode?: 0 | 4 | 5;
  /** Alabama Form A-4's own exemption code. */
  alabamaExemptionCode?: '0' | 'S' | 'MS' | 'M' | 'H';
  /** Arizona Form A-4's elected withholding percentage, as a decimal (e.g. 0.02 for 2.0%) — must be one of that year's cfg.availableRates. */
  electedRate?: number;
  /** Arizona Form A-4's own zero-withholding election, distinct from simply having no form on file. */
  zeroElection?: boolean;

  // --- multi-employer / payroll-history facts, disclosed as caller-only knowledge everywhere else in this engine ---
  /** Denver-family Occupational Privilege Tax: whether this employee's $50,000 lifetime severance exemption cap already has amount used this year, in cents. */
  severanceExemptYtd?: Cents;
  /** Delaware severance exemption: caller's own on-file approval assertion. */
  severanceApprovalOnFile?: boolean;
  /** Washington Paid Leave exemption on file (unverified by this engine). */
  paidLeaveExempt?: boolean;
  /** Washington Paid Leave: this employer's own chosen rate override. */
  paidLeaveEmployeeRateOverride?: number;
  /** WA Cares Fund exemption on file (unverified by this engine) — a separate mechanism from paidLeaveExempt/exempt. */
  wacaresExempt?: boolean;
  /** Newark payroll tax: whether this employer is liable for the employee's paid-leave share, per the employer's own size determination. */
  employerLiableForPaidLeaveShare?: boolean;

  /**
   * Forward-compatibility escape hatch for a certificate field not yet
   * catalogued above (a new state, or a field this list missed) — see this
   * interface's own doc comment. Reading through here bypasses the type
   * checking every field above gives; prefer adding the field above it
   * instead of relying on this for anything long-lived.
   */
  [key: string]: unknown;
}

export interface StateWithholding {
  /** Two-letter code, e.g. 'PA'. */
  code: string;
  /** State-specific certificate fields; shape varies by state — see StateCertificate for the full catalog this engine actually reads. */
  certificate?: StateCertificate;
}

/**
 * Facts about the EMPLOYER rather than the employee. Payroll taxes on the
 * employer side are mostly experience-rated: the state assigns each
 * employer its own rate every year based on its own layoff history, so no
 * jurisdiction file can hold it and no engine can derive it. This is where
 * a caller supplies what only it knows.
 */
export interface EmployerContext {
  /**
   * The employer's own assigned state unemployment (SUI/SUTA) contribution
   * rate, keyed by state code — 0.031 for 3.1%. When absent, the engine
   * falls back to that state's published NEW-EMPLOYER rate and says so in
   * the line's detail, because a new employer genuinely pays that rate;
   * where a state publishes no single new-employer figure (industry- or
   * schedule-assigned), no line is produced rather than a guessed one.
   */
  stateUnemploymentRate?: Record<string, number>;
  /**
   * A handful of states publish a TWO-TIER SUI/SUTA taxable wage base — a
   * higher statutory default, and a reduced base for employers who qualify
   * (typically: current on all quarterly filings, no unpaid balance).
   * Michigan is the confirmed case (data/states/MI-2026.json's own
   * unemploymentInsurance.wageBase: $9,500 default / $9,000 qualified,
   * gated additionally on a UIA Trust Fund balance test this engine has no
   * way to evaluate). Keyed by state code; absent or false means the
   * DEFAULT (higher) base applies — the conservative choice, since the
   * reduced base is an opt-in discount an employer must affirmatively
   * qualify for, not something to assume in the caller's favor.
   */
  stateUnemploymentQualifiedForReducedWageBase?: Record<string, boolean>;
  /**
   * Several states offer a flat supplemental-wage rate as an EMPLOYER
   * OPTION rather than a mandate — Missouri's 4.7%, Nebraska's 3.5%,
   * Oregon's 8%, Maine's 5%, North Carolina's 4.09% — the alternative
   * always being to aggregate the bonus with regular wages and run the
   * normal formula. Which one an employer uses is a payroll policy
   * decision, not a fact about the employee, so it lives here. Keyed by
   * state code; absent or false means aggregate, which is what the engine
   * does by default.
   */
  supplementalFlatRateElection?: Record<string, boolean>;
  /**
   * How a flat per-employee QUARTERLY fee (New Mexico's workers'
   * compensation fee) is collected on this cheque, keyed by state code:
   * 'prorated' (default) spreads the quarter's employee share evenly across
   * the pay periods; 'full' takes the whole quarterly share on this cheque
   * (an employer that collects once, e.g. on the last pay of the quarter);
   * 'skip' takes nothing this cheque — for the other cheques under 'full',
   * or an employer the fee doesn't cover (New Mexico: fewer than three
   * employees and outside construction licensing).
   */
  quarterlyHeadFeeCollection?: Record<string, 'prorated' | 'full' | 'skip'>;
  /**
   * Cash wages paid to ALL household employees in the current calendar
   * quarter BEFORE this check — the FUTA test for domestic employment
   * ($1,000 in any quarter). This engine adds the cash wages on the check
   * being calculated, the same way categoryCashWages works for the annual
   * FICA test. An employer-wide figure, so only the employer has it.
   */
  householdQuarterlyCashWages?: Cents;
  /**
   * Wages paid to ALL farmworkers this year — the $2,500 test, which makes
   * every farmworker's pay taxable regardless of how little any one of them
   * earned.
   */
  agriculturalTotalWages?: Cents;
  /**
   * Whether this employer meets the agricultural FUTA test ($20,000 of farm
   * wages in a calendar quarter, or 10 or more farmworkers on 20 days in
   * 20 different weeks). Both halves are employer-wide facts across a year,
   * so the caller asserts the conclusion.
   */
  agriculturalFutaLiable?: boolean;
  /**
   * This railroad employer's own experience-rated RUIA contribution rate.
   * The published range for 2026 runs from 0.65% — which 91% of covered
   * employers pay — to 12.0%. Absent, the new-employer rate is used.
   */
  railroadUnemploymentRate?: number;
  /**
   * This employer's total PRIOR-YEAR Seattle payroll expense, which decides
   * both whether Seattle's payroll expense tax (JumpStart) applies at all
   * and which rate tier it applies at. An employer-wide, prior-year figure:
   * nothing in a single paycheck can imply it, so the tax computes nothing
   * without it.
   */
  seattlePriorYearPayrollExpense?: Cents;
  /**
   * How much of a paid-leave premium this employer passes on to employees,
   * as a fraction of the TOTAL premium, keyed by state code. Delaware funds
   * its programme entirely from the employer by statute but lets the
   * employer recover up to half from employees — a genuine election with a
   * ceiling, not a fixed rate, so no jurisdiction file can hold it. Values
   * above the state's own ceiling are clamped to it.
   */
  paidLeaveEmployeeShareFraction?: Record<string, number>;
  /**
   * Which paid-leave coverage tier this employer falls in, keyed by state
   * code. Delaware's premium depends on headcount: 1-9 employees are exempt
   * from the Act entirely, 10-24 owe the parental component only, 25+ owe
   * all three. Headcount is an employer fact, so the caller names the tier
   * ('exempt', 'parentalOnly', 'full') and a state whose config requires one
   * computes nothing until it arrives.
   */
  paidLeaveTier?: Record<string, string>;
  /**
   * This employer's SUI-relevant industry classification, keyed by state
   * code — currently only meaningful where a state's own new-employer SUI
   * rate is CONDITIONED on industry (Kansas: 5.55% for construction,
   * 1.75% for everyone else). Absent means the state's plain new-employer
   * rate applies, the same "unknown fact, use the general rule" default
   * this engine already applies to an unsupplied stateUnemploymentRate —
   * never guessed from anything else in the paycheck.
   */
  suiIndustry?: Record<string, string>;
}

/**
 * Which body of employment-tax rules this worker falls under. Most people
 * are 'standard'; the others are real categories the Internal Revenue Code
 * treats differently, and getting them wrong means withholding taxes that
 * are not owed or missing ones that are.
 *
 *   'clergy'            — a duly ordained, commissioned or licensed
 *                         minister performing services in the exercise of
 *                         their ministry. Not subject to income tax, social
 *                         security or Medicare WITHHOLDING (they pay
 *                         self-employment tax instead under SECA), and the
 *                         services are excluded from FUTA employment.
 *   'statutory_employee'— not a common-law employee, but an employee by
 *                         statute for FICA: social security and Medicare
 *                         ARE withheld, federal income tax is NOT.
 *
 * State treatment is a separate question this flag does NOT answer — see
 * the federal ruleset's own employmentCategories block.
 */
/**
 *   'household'         — a domestic worker in a private home. FICA applies
 *                         only once cash wages to that worker reach the
 *                         year's coverage threshold ($3,000 for 2026), and
 *                         FUTA only once household cash wages reach $1,000
 *                         in a calendar quarter. Income tax withholding is
 *                         not required at all.
 *   'agricultural'      — a farmworker. FICA and income tax withholding
 *                         apply only if the worker is paid $150 or more in
 *                         the year, OR the employer pays $2,500 or more to
 *                         all farmworkers.
 */
/**
 *   'railroad'          — covered rail employment, taxed under the Railroad
 *                         Retirement Tax Act instead of FICA. Tier I is
 *                         arithmetically identical to social security and
 *                         Medicare but is a different tax reported on a
 *                         different return; Tier II is an additional tax
 *                         with its own rate and its own wage base. Railroad
 *                         employers pay unemployment contributions under the
 *                         RUIA, not FUTA.
 */
/**
 *   'election_worker'   — a poll worker or election official paid by a
 *                         state or local government. FICA applies only once
 *                         payments reach the year's threshold ($2,500 for
 *                         2026); the work is government employment, so it
 *                         is outside FUTA entirely, and income tax is not
 *                         withheld unless the worker asks for it.
 */
export type EmploymentCategory =
  | 'standard'
  | 'clergy'
  | 'statutory_employee'
  | 'household'
  | 'agricultural'
  | 'railroad'
  | 'election_worker';

export interface PaycheckInput {
  /**
   * Check date. Determines WHICH ruleset applies — never "today".
   * A recalculation of a prior period must reproduce that period's rules.
   */
  checkDate: string; // ISO yyyy-mm-dd
  payFrequency: PayFrequency;
  earnings: Earning[];
  deductions: Deduction[];
  federalW4: FederalW4;
  ytd: YearToDate;
  /** Employer-side facts the engine cannot derive — see EmployerContext. */
  employer?: EmployerContext;
  /** Which employment-tax rules apply to this worker. Defaults to 'standard'. */
  employmentCategory?: EmploymentCategory;
  /**
   * The employee's most recent REGULAR payment, for states whose rule for a
   * bonus paid on its own cheque is "aggregate it with the last regular
   * payment, compute tax on the total, and subtract the tax already
   * withheld then". That instruction reaches backwards across paychecks,
   * which a single calculatePaycheck() call cannot do on its own — so the
   * caller, who has the payroll history, supplies it.
   *
   * Omitted (the normal case) means the bonus is taxed on its own, exactly
   * as before.
   */
  priorRegularPayment?: {
    /** Taxable wages of that prior regular payment. */
    taxableWages: Cents;
    /** State income tax actually withheld from it. */
    stateIncomeTaxWithheld?: Cents;
  };
  /**
   * Hours worked this pay period. Read only by per-hour levies (Oregon's
   * Workers' Benefit Fund); when omitted those fall back to the state's own
   * flat-rate hours for the pay frequency.
   */
  hoursWorked?: number;
  /** Where the work is performed — whose state income tax rules run. */
  workState?: StateWithholding;
  /**
   * Where the employee lives — omit it and every residence-based rule
   * (reciprocity, nonresident allocation, day-count/dollar de minimis
   * thresholds, resident-working-elsewhere credits) simply doesn't fire,
   * the same "absent input changes nothing" convention used everywhere
   * else in this engine. Set it whenever workState and the employee's home
   * state differ; a same-state employee needs it too only if a rule keys
   * off residenceState.certificate specifically (e.g. a reciprocity
   * eligibility flag) rather than off workState.code alone.
   */
  residenceState?: StateWithholding;
  /**
   * Whether to withhold the RESIDENCE state's own tax on top of (or instead
   * of) the work state's — for the case reciprocity doesn't already cover:
   * an employee living in one state and working in another with no
   * reciprocal agreement between them. This engine cannot determine either
   * fact on its own; both are legal/business facts the caller must supply.
   *
   *   - `nexus`: the employer is registered/has a legal presence in the
   *     residence state and is therefore REQUIRED to withhold there.
   *   - `voluntary`: no nexus, but the employer agreed to withhold anyway
   *     as a courtesy so the employee isn't stuck making estimated
   *     payments — Minnesota's own instructions call this "a courtesy to
   *     your employee"; Rhode Island calls the identical practice
   *     "CONVENIENCE WITHHOLDING." Neither state requires it; both permit
   *     it, entirely at the employer's discretion.
   *
   * Ignored whenever a reciprocity exemption or swap already governs this
   * pay period (see reciprocitySwapWithholdingLine()'s own doc comment) —
   * those are mandatory, statute-driven mechanisms and take precedence
   * over this caller-elected one. Also ignored when residenceState is the
   * same as workState, or unset.
   */
  residenceStateWithholding?: {
    nexus?: boolean;
    voluntary?: boolean;
  };
  /** Round withholding to whole dollars, as IRS permits. */
  roundToWholeDollars?: boolean;
}

export interface TaxLine {
  /** Stable identifier, e.g. 'US_FIT', 'US_SS_EE', 'PA_SIT'. */
  id: string;
  name: string;
  /** Who pays: withheld from employee, or employer-borne. */
  payer: 'employee' | 'employer';
  jurisdiction: 'federal' | 'state' | 'local';
  /** The base this tax was actually computed on, after its own exemptions. */
  taxableWages: Cents;
  amount: Cents;
  /** Human-readable trace of how the number was reached. */
  detail?: string;
  /**
   * Set when this line rests on something weaker than a confirmed primary
   * source, or on a certificate choice the engine doesn't model. Absent on
   * the (normal) primary-source-confirmed line. Every marked line is also
   * listed in PaycheckResult.notices.
   */
  dataQuality?: DataQuality;
}

export interface DataQuality {
  /**
   * secondary_source: rate from an aggregator/survey, not the levying
   *   body's own ordinance or form.
   * inferred: rate inferred from a pattern, not read from any source for
   *   this jurisdiction.
   * not_modelled: the employee's certificate asks for a method the engine
   *   doesn't implement; the standard method was used instead.
   * conflicting_sources: the levying body's own form and another
   *   published source disagree; the note says which figure was used.
   */
  tier: 'secondary_source' | 'inferred' | 'not_modelled' | 'conflicting_sources';
  note: string;
}

/** A PaycheckResult-level warning a payroll operator should read before paying. */
export interface DataNotice extends DataQuality {
  /** The TaxLine id this notice is about. */
  taxId: string;
}

export interface PaycheckResult {
  checkDate: string;
  /** Cash earnings (excludes imputed income). */
  grossPay: Cents;
  /** Sum of all pre-tax deductions. */
  pretaxDeductions: Cents;
  /** Sum of all post-tax deductions. */
  posttaxDeductions: Cents;
  taxes: TaxLine[];
  employeeTaxTotal: Cents;
  employerTaxTotal: Cents;
  netPay: Cents;
  /**
   * Data-quality warnings for this paycheck (one per marked TaxLine).
   * Present only when there is at least one: a calculation touching a
   * lower-confidence rate or an unmodelled election still returns a
   * number, but says so here rather than only in the data files.
   */
  notices?: DataNotice[];
  /**
   * Plain-language problems with the paycheck as a whole, present only when
   * there is one. Today: taxes and deductions add up to more than the pay,
   * so net pay is negative and something has to give (the employer decides
   * what; the engine does not silently drop a withholding).
   */
  warnings?: string[];
}

/**
 * A tax rule. Each returns zero or more lines.
 *
 * Rules are discovered from the registry at calculation time rather than
 * hardcoded into the caller, so adding a jurisdiction is a data + module
 * change, never a change to the calculation driver.
 */
export interface TaxRule {
  id: string;
  compute(input: PaycheckInput, ctx: ComputeContext): TaxLine[];
}

export interface ComputeContext {
  year: number;
  periodsPerYear: number;
  /** Resolve the taxable base for a given tax's exemption profile. */
  taxableWagesFor(exempt: readonly PretaxCategory[]): Cents;
}
