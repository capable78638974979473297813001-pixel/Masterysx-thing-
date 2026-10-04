import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * JEDD rows added 2026-09-28 from each district's own administrator, plus
 * the annual earnings caps and termination dates the Finder CSV doesn't
 * carry. Amounts are biweekly $4,000 checks.
 */

const paycheck = (jeddId: string, checkDate = '2026-06-12', ytdDistrictWages?: number): PaycheckInput => ({
  checkDate,
  payFrequency: 'biweekly',
  earnings: [{ code: 'REG', category: 'regular', amount: 400000 }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: {
    socialSecurity: 0, medicare: 0, futa: 0,
    ...(ytdDistrictWages === undefined ? {} : { localIncomeTax: { [`OH_JEDD_${jeddId}`]: ytdDistrictWages } }),
  },
  workState: { code: 'OH', certificate: { workJEDDId: jeddId } } as PaycheckInput['workState'],
});
const jedd = (input: PaycheckInput) => calculatePaycheck(input).taxes.find((t) => t.id === 'OH_JEDD');

describe('Ohio JEDD rows sourced 2026-09-28', () => {
  test('new rates: Warren-Champion 2.5%, Sylvania-Toledo 1.5%, Apple Creek-East Union 1%', () => {
    assert.equal(jedd(paycheck('9155'))?.amount, 10000);
    assert.equal(jedd(paycheck('9069'))?.amount, 6000);
    assert.equal(jedd(paycheck('9142'))?.amount, 4000);
    assert.equal(jedd(paycheck('9143'))?.amount, 4000);
  });

  test('a terminated or dissolved district levies nothing', () => {
    assert.equal(jedd(paycheck('9123')), undefined); // Jefferson Twp-Whitehall, ended 2024-11-19
    assert.equal(jedd(paycheck('9022')), undefined); // Liberty Center, dissolved
  });

  test('a district that starts mid-year levies nothing before its start date', () => {
    // Jersey-New Albany JEDD 1: effective 2026-05-01.
    assert.equal(jedd(paycheck('9158', '2026-04-17')), undefined);
    assert.ok(jedd(paycheck('9158', '2026-05-15')));
  });

  test('an annual earnings cap stops the tax once district wages reach it', () => {
    // Mercy West JEDD III: 1.5%, $109,375 cap for 2026.
    assert.equal(jedd(paycheck('9098', '2026-06-12', 0))?.amount, 6000);
    const partial = jedd(paycheck('9098', '2026-06-12', 107_375_00))!; // $2,000 of room left
    assert.equal(partial.taxableWages, 200000);
    assert.equal(partial.amount, 3000);
    assert.equal(jedd(paycheck('9098', '2026-06-12', 109_375_00))?.amount, 0);
    // Western Ridge: 1%, $148,311 cap — the pre-existing row, previously uncapped.
    assert.equal(jedd(paycheck('9091', '2026-06-12', 148_311_00))?.amount, 0);
  });

  test('an uncapped district ignores YTD', () => {
    assert.equal(jedd(paycheck('9135', '2026-06-12', 500_000_00))?.amount, 8000); // Hampton Inn, 2%, no cap
  });
});
