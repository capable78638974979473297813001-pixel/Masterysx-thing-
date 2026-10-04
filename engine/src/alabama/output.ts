import { fmt } from '../money.ts';
import type { Cents } from '../money.ts';
import { PERIODS_PER_YEAR } from '../types.ts';
import type { PaycheckResult, TaxLine } from '../types.ts';
import type { AlabamaBuildResult } from './input.ts';
import type {
  A4ExemptionCode,
  Amount,
  AlabamaPaycheckInput,
  AlabamaPaycheckOutput,
  AlabamaTaxLineOutput,
} from './types.ts';

function amount(cents: Cents): Amount {
  return { cents, dollars: cents / 100, display: fmt(cents) };
}

function toLine(line: TaxLine): AlabamaTaxLineOutput {
  return {
    id: line.id,
    name: line.name,
    payer: line.payer,
    jurisdiction: line.jurisdiction,
    taxableWages: amount(line.taxableWages),
    amount: amount(line.amount),
    detail: line.detail ?? '',
  };
}

const CODE_MEANING: Record<A4ExemptionCode, string> = {
  '0': 'no personal exemption claimed',
  S: 'single, $1,500 personal exemption',
  MS: 'married filing separately, $1,500 personal exemption',
  M: 'married claiming both exemptions, $3,000',
  H: 'head of family, $3,000',
};

/**
 * Assemble the Alabama-shaped result.
 *
 * The engine's lines are carried through verbatim in `raw` and their own
 * detail strings are reused rather than paraphrased — a paraphrase is a
 * second place for the arithmetic to be described, and the second
 * description is the one that goes stale. What this adds is the Alabama
 * view: which A-4 code drove which bracket schedule, what the municipal
 * occupational tax came to, what the employer's own unemployment
 * contribution costs, and a plain-language account of the Alabama-specific
 * rules that actually fired on this cheque.
 */
export function buildAlabamaOutput(
  input: AlabamaPaycheckInput,
  built: AlabamaBuildResult,
  result: PaycheckResult,
): AlabamaPaycheckOutput {
  const employeeTaxes = result.taxes.filter((t) => t.payer === 'employee').map(toLine);
  const employerTaxes = result.taxes.filter((t) => t.payer === 'employer').map(toLine);

  const sit = result.taxes.filter((t) => t.id.startsWith('AL_SIT'));
  const sitTotal = sit.reduce((sum, t) => sum + t.amount, 0);
  const local = result.taxes.find((t) => t.id === 'AL_LOCAL');
  const county = result.taxes.find((t) => t.id === 'AL_COUNTY');
  const sui = result.taxes.find((t) => t.id === 'AL_SUI_ER');

  const alabamaBase = result.taxes.find((t) => t.id === 'AL_SIT')?.taxableWages ?? 0;

  const explanation = explain(input, built, result);

  return {
    checkDate: result.checkDate,
    payFrequency: input.payFrequency,
    periodsPerYear: PERIODS_PER_YEAR[input.payFrequency],
    ...(input.employeeName ? { employeeName: input.employeeName } : {}),
    ...(input.employer?.name ? { employerName: input.employer.name } : {}),

    grossPay: amount(result.grossPay),
    alabamaTaxableWages: amount(alabamaBase),
    pretaxDeductions: amount(result.pretaxDeductions),
    posttaxDeductions: amount(result.posttaxDeductions),

    employeeTaxes,
    employerTaxes,
    employeeTaxTotal: amount(result.employeeTaxTotal),
    employerTaxTotal: amount(result.employerTaxTotal),
    netPay: amount(result.netPay),
    employerCost: amount(result.grossPay + result.employerTaxTotal),

    alabama: {
      stateIncomeTax: amount(sitTotal),
      ...(local && built.matchedCity
        ? {
            localOccupationalTax: {
              city: built.matchedCity.name,
              rate: built.matchedCity.rate,
              amount: amount(local.amount),
            },
          }
        : {}),
      ...(county && built.matchedCounty
        ? {
            countyOccupationalTax: {
              county: built.matchedCounty.name,
              rate: built.matchedCounty.rate,
              amount: amount(county.amount),
            },
          }
        : {}),
      ...(sui ? { unemploymentEmployer: amount(sui.amount) } : {}),
      a4: {
        exemptionCode: built.a4.exemptionCode,
        dependents: built.a4.dependents,
        bracketSchedule: built.a4.exemptionCode === 'M' ? 'M' : 'non-M',
      },
      explanation,
    },

    warnings: built.warnings,
    raw: result.taxes,
  };
}

function explain(
  input: AlabamaPaycheckInput,
  built: AlabamaBuildResult,
  result: PaycheckResult,
): string[] {
  const out: string[] = [];
  const code = built.a4.exemptionCode;

  out.push(
    `Form A-4: code "${code}" (${CODE_MEANING[code]}), ${built.a4.dependents} dependent(s). Alabama runs ` +
      `two bracket schedules and only code "M" gets the wider one, so this cheque used the ` +
      `${code === 'M' ? '"M"' : 'non-"M"'} schedule (2% / 4% / 5%).` +
      (input.a4?.exemptionCode === undefined
        ? ` No exemption code was supplied, which the booklet answers directly: with no A-4 on file, ` +
          `"the employer should withhold using zero exemptions."`
        : ''),
  );

  const fed = result.taxes.find((t) => t.id === 'US_FIT');
  if (fed) {
    out.push(
      `Alabama's formula is unusual: the employee's own ANNUAL FEDERAL WITHHOLDING is subtracted from ` +
        `Alabama gross income before the brackets apply. This cheque's federal withholding of ` +
        `${fmt(fed.amount)} became ${fmt(fed.amount * PERIODS_PER_YEAR[input.payFrequency])} of deduction — ` +
        `which is why anything that changes federal withholding also moves the Alabama number.`,
    );
  }

  for (const line of result.taxes) {
    if (line.id.startsWith('AL_SIT') && line.detail) {
      out.push(`${line.name}: ${line.detail}`);
    }
  }

  const local = result.taxes.find((t) => t.id === 'AL_LOCAL');
  if (local) {
    out.push(
      `${local.name}: ${local.detail}. This is a municipal levy under the city's own home-rule authority ` +
        `(Code of Ala. Sec. 11-51-90), not a state tax — it is unaffected by the A-4, by the 30-day safe ` +
        `harbor, and by any state-level exemption on this cheque.`,
    );
  } else if (input.workCity && !built.matchedCity) {
    out.push(
      `Work city "${input.workCity}" is not among the Alabama municipalities known to levy an ` +
        `occupational tax, so no local line was produced. Most Alabama cities levy none.`,
    );
  }
  const countyLine = result.taxes.find((t) => t.id === 'AL_COUNTY');
  if (countyLine) {
    out.push(
      `${countyLine.name}: ${countyLine.detail}. Persons over 65 who are not gainfully employed and domestic ` +
        `servants in private homes are exempt, and an employee's Sec. 40-12-40 professional license fee is ` +
        `credited against it on their own return; neither is applied here.`,
    );
  } else if (built.matchedCounty && local) {
    out.push(
      `${built.matchedCounty.name} County's occupational fee does not apply: ${local.name.replace(/ Occupational Tax$/, '')} ` +
        `already taxed work there on 2019-06-10, the statute's cutoff.`,
    );
  }

  const sui = result.taxes.find((t) => t.id === 'AL_SUI_ER');
  if (sui) {
    out.push(`${sui.name} (employer-paid, not withheld): ${sui.detail}`);
  }

  if (input.employmentCategory && input.employmentCategory !== 'standard') {
    out.push(
      `Employment category "${input.employmentCategory}": Alabama excludes domestic service in a private ` +
        `home, merchant seamen, ministers and agricultural labour from its own income tax withholding — and ` +
        `for agricultural labour it explicitly declines to follow the federal rule that WOULD tax it. The ` +
        `federal lines above are decided separately, on federal terms.`,
    );
  }

  if ((input.earnings?.severance ?? 0) > 0) {
    out.push(
      `Severance of ${fmt(Math.round((input.earnings.severance ?? 0) * 100))} was paid. Alabama exempts up ` +
        `to $50,000 per employee of severance, termination pay or supplemental-income-plan pay from an ` +
        `administrative downsizing — but only with the Department of Revenue's prior approval, which is why ` +
        `this engine exempts nothing until severanceExemption.approvalOnFile is asserted.`,
    );
  }

  return out;
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s.padEnd(n));
const rpad = (s: string, n: number) => s.padStart(n);
const LABEL = 42;
const COL = 14;

/** Wrap a long paragraph to a fixed width, for the notes at the bottom. */
function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? indent + l : indent + '  ' + l));
}

/**
 * The paystub, as text. Deliberately plain: this is the artifact a person
 * checks a paycheque against, so every figure a payroll clerk would look
 * for appears exactly once, in the order they would look for it, and the
 * Alabama-specific reasoning follows underneath rather than interrupting.
 */
export function formatAlabamaPaystub(output: AlabamaPaycheckOutput): string {
  const l: string[] = [];
  const title = output.employeeName ? `PAYCHECK — ${output.employeeName}` : 'PAYCHECK';

  l.push('');
  l.push(`  ${title}`);
  l.push(
    `  ${output.checkDate}   ${output.payFrequency} (${output.periodsPerYear}/yr)   Alabama` +
      (output.alabama.localOccupationalTax ? ` — ${output.alabama.localOccupationalTax.city}` : ''),
  );
  if (output.employerName) l.push(`  Employer: ${output.employerName}`);
  l.push(`  ${'='.repeat(LABEL + COL * 2)}`);

  l.push('');
  l.push(`  ${pad('EARNINGS', LABEL)}${rpad('', COL)}${rpad('amount', COL)}`);
  l.push(`  ${pad('Gross pay (cash)', LABEL)}${rpad('', COL)}${rpad(output.grossPay.display, COL)}`);
  l.push(
    `  ${pad('Alabama taxable wages', LABEL)}${rpad('', COL)}${rpad(output.alabamaTaxableWages.display, COL)}`,
  );
  l.push(`  ${pad('Pre-tax deductions', LABEL)}${rpad('', COL)}${rpad('-' + output.pretaxDeductions.display, COL)}`);
  l.push(`  ${pad('Post-tax deductions', LABEL)}${rpad('', COL)}${rpad('-' + output.posttaxDeductions.display, COL)}`);

  l.push('');
  l.push(`  ${pad('WITHHELD FROM EMPLOYEE', LABEL)}${rpad('taxable', COL)}${rpad('amount', COL)}`);
  for (const t of output.employeeTaxes) {
    l.push(`  ${pad(t.name, LABEL)}${rpad(t.taxableWages.display, COL)}${rpad(t.amount.display, COL)}`);
  }
  l.push(`  ${pad('', LABEL)}${rpad('', COL)}${rpad('-'.repeat(12), COL)}`);
  l.push(`  ${pad('Total withheld', LABEL)}${rpad('', COL)}${rpad(output.employeeTaxTotal.display, COL)}`);

  l.push('');
  l.push(`  ${pad('NET PAY', LABEL)}${rpad('', COL)}${rpad(output.netPay.display, COL)}`);

  if (output.employerTaxes.length > 0) {
    l.push('');
    l.push(`  ${pad('EMPLOYER COST (not withheld)', LABEL)}${rpad('taxable', COL)}${rpad('amount', COL)}`);
    for (const t of output.employerTaxes) {
      l.push(`  ${pad(t.name, LABEL)}${rpad(t.taxableWages.display, COL)}${rpad(t.amount.display, COL)}`);
    }
    l.push(`  ${pad('Total employer tax', LABEL)}${rpad('', COL)}${rpad(output.employerTaxTotal.display, COL)}`);
    l.push(`  ${pad('Total cost of this paycheck', LABEL)}${rpad('', COL)}${rpad(output.employerCost.display, COL)}`);
  }

  l.push('');
  l.push(`  ALABAMA`);
  l.push(
    `  ${pad('State income tax (AL_SIT)', LABEL)}${rpad('', COL)}${rpad(output.alabama.stateIncomeTax.display, COL)}`,
  );
  if (output.alabama.localOccupationalTax) {
    const lo = output.alabama.localOccupationalTax;
    l.push(
      `  ${pad(`${lo.city} occupational tax @ ${(lo.rate * 100).toFixed(2)}%`, LABEL)}${rpad('', COL)}${rpad(lo.amount.display, COL)}`,
    );
  }
  if (output.alabama.unemploymentEmployer) {
    l.push(
      `  ${pad('AL unemployment (employer)', LABEL)}${rpad('', COL)}${rpad(output.alabama.unemploymentEmployer.display, COL)}`,
    );
  }

  l.push('');
  l.push('  HOW ALABAMA GOT THERE');
  for (const line of output.alabama.explanation) {
    l.push(...wrap(line, 92, '  · '));
  }

  if (output.warnings.length > 0) {
    l.push('');
    l.push('  WORTH CHECKING');
    for (const w of output.warnings) {
      l.push(...wrap(w, 92, '  ! '));
    }
  }

  l.push('');
  return l.join('\n');
}
