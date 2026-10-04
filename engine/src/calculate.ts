import { toWholeDollars } from './money.ts';

/**
 * IRS whole-dollar rounding is for withheld income tax. FICA, FUTA, SUTA,
 * disability, paid leave, transit excise, and flat head taxes stay in cents.
 */
function isWithheldIncomeTax(id: string): boolean {
  if (id === 'US_FIT' || id === 'US_FIT_SUPP') return true;
  if (id.includes('_SIT')) return true;
  return (
    id.endsWith('_COUNTY') ||
    id === 'PA_EIT' ||
    id === 'MI_LOCAL' ||
    id === 'OH_LOCAL' ||
    id === 'OH_JEDD' ||
    id === 'OH_SDIT' ||
    id === 'KY_LOCAL' ||
    id === 'AL_LOCAL' ||
    id === 'WILMINGTON_WAGE' ||
    id === 'KC_EARN' ||
    id === 'STL_EARN' ||
    id === 'OR_METRO_SHS' ||
    id === 'OR_MULTNOMAH_PFA'
  );
}
import { PERIODS_PER_YEAR } from './types.ts';
import type {
  ComputeContext,
  DataNotice,
  PaycheckInput,
  PaycheckResult,
  TaxLine,
} from './types.ts';
import { assertTaxYearCovered, CannotComputeError, federalRuleset, yearOf } from './registry.ts';
import { federalTaxes } from './taxes/federal.ts';
import { stateIncomeTax } from './taxes/state.ts';
import {
  capElectiveDeferrals,
  cashEarnings,
  makeTaxableWagesFn,
  posttaxTotal,
  pretaxTotal,
} from './wages.ts';

/**
 * Gross-to-net for a single paycheck.
 *
 * The driver knows nothing about specific taxes. It builds the context —
 * notably the per-tax taxable-wage resolver — and lets each rule declare its
 * own base, so a new jurisdiction never requires editing this function.
 */
export function calculatePaycheck(input: PaycheckInput): PaycheckResult {
  const periodsPerYear = PERIODS_PER_YEAR[input.payFrequency];
  if (!periodsPerYear) {
    throw new Error(`Unknown pay frequency: ${input.payFrequency}`);
  }
  // 2025 is covered for federal tax and only some states; a paycheck
  // touching any other state that year is refused, not computed federal-only.
  assertTaxYearCovered(input.checkDate, [input.workState?.code, input.residenceState?.code]);

  // Cap 401(k)/403(b)/457/SIMPLE deductions at their IRC annual elective-
  // deferral limits before ANY tax reads the deduction list — see
  // capElectiveDeferrals()'s own doc comment in wages.ts. Net pay is
  // unaffected (the same total dollar amount still leaves the paycheck);
  // this only changes which taxes see an over-limit amount as taxable.
  const effectiveDeductions = capElectiveDeferrals(
    input.deductions,
    input.ytd.electiveDeferrals,
    federalRuleset(input.checkDate).electiveDeferralLimits,
  );

  const ctx: ComputeContext = {
    year: yearOf(input.checkDate),
    periodsPerYear,
    taxableWagesFor: makeTaxableWagesFn(input.earnings, effectiveDeductions, {
      // A designated housing allowance leaves the tax base only for a
      // minister — see EarningCategory's own doc comment.
      housingAllowanceExcluded: input.employmentCategory === 'clergy',
    }),
  };

  let taxes: TaxLine[];
  try {
    taxes = [...federalTaxes(input, ctx), ...stateIncomeTax(input, ctx)];
  } catch (err) {
    // Rules throw "... cannot compute X" when the agency publishes no method
    // for this input. Give those a type so callers can show the reason.
    if (err instanceof Error && !(err instanceof CannotComputeError) && /cannot compute/i.test(err.message)) {
      throw new CannotComputeError(err.message);
    }
    throw err;
  }

  if (input.roundToWholeDollars) {
    taxes = taxes.map((t) =>
      isWithheldIncomeTax(t.id) ? { ...t, amount: toWholeDollars(t.amount) } : t,
    );
  }

  const employeeTaxTotal = taxes
    .filter((t) => t.payer === 'employee')
    .reduce((sum, t) => sum + t.amount, 0);
  const employerTaxTotal = taxes
    .filter((t) => t.payer === 'employer')
    .reduce((sum, t) => sum + t.amount, 0);

  const gross = cashEarnings(input.earnings);
  const pretax = pretaxTotal(effectiveDeductions);
  const posttax = posttaxTotal(effectiveDeductions);

  const netPay = gross - pretax - posttax - employeeTaxTotal;
  const warnings: string[] = [];
  if (netPay < 0) {
    warnings.push(
      `Taxes and deductions are $${(-netPay / 100).toFixed(2)} more than this paycheck. ` +
        `Net pay is negative; nothing was dropped or reduced automatically. ` +
        `Reduce a deduction or withholding election, or pay the difference another way.`,
    );
  }

  return {
    checkDate: input.checkDate,
    grossPay: gross,
    pretaxDeductions: pretax,
    posttaxDeductions: posttax,
    taxes,
    employeeTaxTotal,
    employerTaxTotal,
    // Employer taxes are a cost to the employer, never a reduction of net pay.
    netPay,
    ...noticesFor(taxes),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Every data-quality-marked line, lifted to the result so it can't be missed. */
function noticesFor(taxes: TaxLine[]): { notices?: DataNotice[] } {
  const notices = taxes
    .filter((t) => t.dataQuality)
    .map((t) => ({ taxId: t.id, ...t.dataQuality! }));
  return notices.length ? { notices } : {};
}
