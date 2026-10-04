import type { Cents } from '../src/money.ts';
import type { EmploymentCategory } from '../src/types.ts';
import type { ExtendedYearToDate } from './types.ts';

/**
 * Everything accumulateYtd() needs out of one paycheck — deliberately NOT
 * the engine's own PaycheckInput/PaycheckResult, so this function works
 * identically whether it's called right after calculatePaycheck() runs
 * (payroll/engine.ts has both in hand) or later, reconstructed purely from
 * an already-approved, persisted PayRunLine (payroll/run.ts's own
 * approvePayRun()) — a PayRunLine's taxLines already carry exactly the id
 * and taxableWages fields this needs, by design (see PayRunLine's own doc
 * comment in types.ts).
 */
export interface YtdAccumulatorInput {
  checkDate: string;
  employmentCategory?: EmploymentCategory;
  /** The paycheck's cash gross — feeds categoryCashWages only; see this module's own header comment. */
  grossPay: Cents;
  taxLines: readonly { id: string; taxableWages: Cents }[];
}

/**
 * Rolls one paycheck's result INTO the running year-to-date totals the tax
 * engine itself needs for its NEXT calculation — every wage-base cap
 * (Social Security, FUTA, a state's SUI/SDI/PFML/LTC), every threshold
 * (Additional Medicare, Oregon's Portland-area local triggers), and the
 * few oddly-shaped trackers (RUIA's MONTHLY reset, Iowa-shaped annual
 * garnishment caps live in the caller's own order records instead) all
 * depend on a caller who remembers what came before. calculatePaycheck()
 * itself is deliberately stateless — see its own header comment — so this
 * is the layer of a real payroll company that keeps the ledger.
 *
 * DESIGN: every rule below adds a TaxLine's own `taxableWages` field to the
 * matching bucket, never `amount`. That is deliberately not an
 * approximation — underCap(current, ytd, cap) (money.ts) returns exactly
 * the slice of THIS period's wages that newly became taxable, so summing
 * `taxableWages` across periods telescopes to the correct cumulative
 * figure by construction, whether or not a cap ever binds.
 *
 * DEDUPING SHARED TRACKERS: several states run an employEE line and an
 * employER line off the SAME wage-base tracker in the SAME calculation
 * (e.g. NJ_UC_EE and NJ_SUI_ER both read/write ytd.stateUnemployment.NJ;
 * WA_PFML_EE and WA_PFML_ER both read/write ytd.statePaidLeave.WA) — this
 * accumulator groups by (bucket, key) and adds each group's figure exactly
 * ONCE, never sums the two lines together (which would double-count the
 * wage base every period a state has both sides configured). Most states
 * with both sides configured give them the identical wage base, so their
 * taxableWages agree by construction and it never matters which one this
 * picks. Pennsylvania does not: PA_UC_EE is uncapped while PA_SUI_ER is
 * capped at $10,000, so above that cap the two genuinely diverge. See
 * resolveKeyed()'s own doc comment below for why the EMPLOYER side is the
 * one this accumulator keeps in that case, deterministically rather than
 * by accident of tax-line order.
 *
 * DISCLOSED, NOT SOLVED HERE — two real trackers this function does not
 * attempt, because the information to derive them correctly does not
 * survive into a PaycheckResult's TaxLine array at all:
 *
 *   - ytd.seattleCompensation needs the employee's FULL per-period Seattle
 *     compensation, including the portion below the per-employee
 *     threshold — but seattlePayrollExpenseTax() (taxes/state.ts) reports
 *     only the IN-BAND slice as `taxableWages`, and returns no line at all
 *     once an employee is entirely below threshold. A generic accumulator
 *     reading only the TaxLine array has no way to recover the excluded
 *     portion. A caller actually running Seattle payroll must track this
 *     total itself from the same taxableWagesFor() figure the engine used
 *     — exactly the same "caller-supplied, never guessed" discipline the
 *     engine already applies to input.employer facts.
 *   - Kentucky's per-jurisdiction SS-wage-base credit (Walton, Florence)
 *     tracks city and county HALVES separately under
 *     ytd.localIncomeTax['KY_LOCAL_<Name>'], but the two halves are
 *     combined into ONE 'KY_LOCAL' TaxLine with one combined amount —
 *     there is no way to split it back apart from the output alone. A
 *     caller using this feature must track each jurisdiction's own running
 *     total directly.
 *
 * Both are exceedingly narrow (one city, two Kentucky municipalities) next
 * to the 50-state surface this function does cover correctly, and are
 * disclosed here rather than force-fit — the same tradeoff README.md's own
 * "Known gaps" section makes throughout the engine itself.
 */

type SimpleBucket = 'socialSecurity' | 'medicare' | 'futa' | 'tier2Compensation' | 'supplemental';
type KeyedBucket = 'stateUnemployment' | 'statePaidLeave' | 'stateDisabilityEmployee' | 'stateLongTermCare';

/** Ids that feed a single, unkeyed federal tracker. Additional Medicare (US_MED_ADDL / US_RRTA_MED_ADDL) is deliberately ABSENT: its taxableWages is the excess slice ABOVE the threshold, a subset of what US_MED_EE already reports — including it too would double-count. */
const SIMPLE_ID_TO_BUCKET: Readonly<Record<string, SimpleBucket>> = {
  US_SS_EE: 'socialSecurity',
  US_SS_ER: 'socialSecurity',
  US_RRTA_TIER1_EE: 'socialSecurity',
  US_RRTA_TIER1_ER: 'socialSecurity',
  US_MED_EE: 'medicare',
  US_MED_ER: 'medicare',
  US_RRTA_MED_EE: 'medicare',
  US_RRTA_MED_ER: 'medicare',
  US_FUTA: 'futa',
  US_RRTA_TIER2_EE: 'tier2Compensation',
  US_RRTA_TIER2_ER: 'tier2Compensation',
  US_FIT_SUPP: 'supplemental',
};

/**
 * State-code-prefixed id SUFFIXES that feed a KEYED tracker, keyed by the
 * two-letter code the id itself starts with. `role` says which side of a
 * shared bucket (stateUnemployment: `_UC_EE` + `_SUI_ER`; statePaidLeave:
 * `_PFML_EE` + `_PFML_ER`) this suffix is — see resolveKeyed()'s own doc
 * comment for why that matters.
 */
const KEYED_ID_SUFFIX_TO_BUCKET: ReadonlyArray<{ suffix: string; bucket: KeyedBucket; role: 'employee' | 'employer' }> = [
  { suffix: '_UC_EE', bucket: 'stateUnemployment', role: 'employee' },
  { suffix: '_SUI_ER', bucket: 'stateUnemployment', role: 'employer' },
  { suffix: '_PFML_EE', bucket: 'statePaidLeave', role: 'employee' },
  { suffix: '_PFML_ER', bucket: 'statePaidLeave', role: 'employer' },
  { suffix: '_DBL_EE', bucket: 'stateDisabilityEmployee', role: 'employee' },
  { suffix: '_LTC_EE', bucket: 'stateLongTermCare', role: 'employee' },
];

/** Ids whose YTD key is NOT the state code the id starts with — Oregon's own two Portland-area local triggers key their tracker on a shorter district name than the TaxLine id itself carries (OR_METRO_SHS -> 'OR_METRO', OR_MULTNOMAH_PFA -> 'OR_MULTNOMAH'; see taxes/state.ts's portlandAreaLocalTax()). */
const LOCAL_INCOME_TAX_TRIGGER_ID_TO_KEY: Readonly<Record<string, string>> = {
  OR_METRO_SHS: 'OR_METRO',
  OR_MULTNOMAH_PFA: 'OR_MULTNOMAH',
};

const STATE_PREFIXED_KEYED_ID = /^([A-Z]{2})(_[A-Z_]+)$/;

function checkDateMonth(checkDate: string): string {
  return checkDate.slice(0, 7); // 'YYYY-MM'
}

/** Advance `ytd` by one paycheck. */
export function accumulateYtd(ytd: ExtendedYearToDate, paycheck: YtdAccumulatorInput): ExtendedYearToDate {
  const next: ExtendedYearToDate = {
    ...ytd,
    stateUnemployment: { ...ytd.stateUnemployment },
    statePaidLeave: { ...ytd.statePaidLeave },
    stateDisabilityEmployee: { ...ytd.stateDisabilityEmployee },
    stateLongTermCare: { ...ytd.stateLongTermCare },
    localIncomeTax: { ...ytd.localIncomeTax },
  };

  const simpleAdd: Partial<Record<SimpleBucket, number>> = {};
  // Per (bucket, code), the employee-side and employer-side taxableWages
  // seen this paycheck, tracked SEPARATELY rather than merged as they
  // arrive — see resolveKeyed()'s own doc comment for why.
  const keyedSeen: Partial<Record<KeyedBucket, Record<string, { employee?: number; employer?: number }>>> = {};
  const localTriggerAdd: Record<string, number> = {};

  const record = (line: { id: string; taxableWages: Cents }): void => {
    const simpleBucket = SIMPLE_ID_TO_BUCKET[line.id];
    if (simpleBucket) {
      // Dedupe: a shared tracker's employee/employer lines report the same
      // value by construction (see header comment) — last write wins, and
      // they're always equal, so this is never actually a choice. True for
      // every SIMPLE_ID_TO_BUCKET pair: each is one function computing both
      // its own employee AND employer line from the identical wage figure
      // in a single call (socialSecurity(), medicare(), railroadTier2(),
      // railroadUnemployment()), not two independently-configured taxes —
      // unlike the KEYED buckets below, which can be.
      simpleAdd[simpleBucket] = line.taxableWages;
      return;
    }

    const localKey = LOCAL_INCOME_TAX_TRIGGER_ID_TO_KEY[line.id];
    if (localKey) {
      localTriggerAdd[localKey] = line.taxableWages;
      return;
    }

    for (const { suffix, bucket, role } of KEYED_ID_SUFFIX_TO_BUCKET) {
      if (!line.id.endsWith(suffix)) continue;
      const match = STATE_PREFIXED_KEYED_ID.exec(line.id);
      if (!match) continue;
      const code = match[1];
      keyedSeen[bucket] ??= {};
      const forCode = (keyedSeen[bucket]![code] ??= {});
      forCode[role] = line.taxableWages;
      break;
    }
  };

  for (const line of paycheck.taxLines) record(line);

  /**
   * Two INDEPENDENTLY-CONFIGURED taxes can share one KeyedBucket —
   * stateUnemployment holds both an employee-side UC contribution
   * (`_UC_EE`) and the employer-side SUI/SUTA contribution (`_SUI_ER`),
   * and statePaidLeave holds both PFML halves. Where a state's own data
   * gives both sides the identical wage base (Alaska, New Jersey — see
   * data/states/*.json's stateUnemploymentEmployee.wageBase vs
   * suiEmployer.wageBase), their taxableWages are equal by construction
   * and it never matters which one this picks.
   *
   * Pennsylvania is the one state where they genuinely diverge: PA_UC_EE
   * is UNCAPPED (wageBase: null) while PA_SUI_ER is capped at $10,000, so
   * above that cap their taxableWages differ (verified: a $5,000 cheque
   * with $9,500 YTD reports PA_UC_EE taxableWages=$5,000, PA_SUI_ER
   * taxableWages=$500 — the last $500 before the cap). Only ONE of those
   * two figures is what a LATER paycheck's own computation reads back
   * out of `ytd.stateUnemployment.PA`: stateUnemploymentEmployeeTax()
   * ignores `ytd` entirely when its own wageBase is null (see that
   * function's own body in taxes/state.ts) — it recomputes straight from
   * this period's wages either way — while stateUnemploymentEmployerTax()
   * always reads `ytd` to apply its own cap. So the EMPLOYER figure is
   * the one whose correctness actually depends on what gets stored here;
   * the employee figure's fate is moot for its own next computation.
   * Preferring `employer` when both are present (falling back to
   * `employee` for states that only have one side wired) makes that
   * choice explicit and ORDER-INDEPENDENT, rather than an accident of
   * whichever line taxes/state.ts happens to push last into
   * PaycheckResult.taxes — a future reordering there would silently flip
   * which side survived under the old last-write-wins rule.
   */
  const resolveKeyed = (values: { employee?: number; employer?: number }): number =>
    values.employer ?? values.employee ?? 0;

  for (const [bucket, amount] of Object.entries(simpleAdd)) {
    const b = bucket as SimpleBucket;
    next[b] = (next[b] ?? 0) + amount!;
  }
  const keyedAdd: Partial<Record<KeyedBucket, Record<string, number>>> = {};
  for (const [bucket, byCode] of Object.entries(keyedSeen)) {
    const b = bucket as KeyedBucket;
    const resolved: Record<string, number> = {};
    for (const [code, values] of Object.entries(byCode!)) {
      resolved[code] = resolveKeyed(values);
    }
    keyedAdd[b] = resolved;
  }
  for (const [bucket, byCode] of Object.entries(keyedAdd)) {
    const b = bucket as KeyedBucket;
    const target = { ...(next[b] ?? {}) };
    for (const [code, amount] of Object.entries(byCode!)) {
      target[code] = (target[code] ?? 0) + amount;
    }
    next[b] = target;
  }
  for (const [key, amount] of Object.entries(localTriggerAdd)) {
    next.localIncomeTax![key] = (next.localIncomeTax![key] ?? 0) + amount;
  }

  // categoryCashWages: driven by the paycheck's own cash gross, not by any
  // TaxLine, because the coverage-threshold check it feeds
  // (categoryCoverage() in taxes/federal.ts) runs BEFORE any tax line for
  // an uncovered worker exists at all — see that function's own header
  // comment. Only meaningful for the three categories that use it.
  if (
    paycheck.employmentCategory === 'household' ||
    paycheck.employmentCategory === 'agricultural' ||
    paycheck.employmentCategory === 'election_worker'
  ) {
    next.categoryCashWages = (next.categoryCashWages ?? 0) + paycheck.grossPay;
  }

  // railroadMonthlyCompensation resets on every NEW calendar month rather
  // than accumulating all year — see US_RUIA_ER's own header comment in
  // taxes/federal.ts. Reset happens BEFORE adding this period's figure so
  // a check dated into a new month starts that month's tracker fresh.
  const ruiaLine = paycheck.taxLines.find((t) => t.id === 'US_RUIA_ER');
  if (ruiaLine) {
    const month = checkDateMonth(paycheck.checkDate);
    const sameMonth = next.railroadMonthlyCompensationMonth === month;
    next.railroadMonthlyCompensation = (sameMonth ? (next.railroadMonthlyCompensation ?? 0) : 0) + ruiaLine.taxableWages;
    next.railroadMonthlyCompensationMonth = month;
  }

  return next;
}

/** A fresh YearToDate for the first check of a new calendar year — every wage-base tracker this engine has back to zero, the same "one calendar year, then start over" rule every jurisdiction file itself assumes. */
export function freshYearToDate(): ExtendedYearToDate {
  return {
    socialSecurity: 0,
    medicare: 0,
    futa: 0,
    stateUnemployment: {},
    statePaidLeave: {},
    stateDisabilityEmployee: {},
    stateLongTermCare: {},
    localIncomeTax: {},
  };
}
