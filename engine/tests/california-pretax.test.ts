import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import type { Deduction, PaycheckInput } from '../src/types.ts';

/**
 * California's treatment of pre-tax deductions, read from EDD DE 231EB
 * (Rev. 12, 6-17) and DE 231TP (Rev. 1, 6-16):
 *   - cafeteria-plan health / dependent-care salary reductions, FSA and
 *     qualified transportation: Not Subject to UI/ETT, SDI or PIT;
 *   - HSA contributions: Subject to UI/ETT, SDI AND PIT, cafeteria plan or
 *     not (RTC 17131.4 / 17131.5 -- no conformity to the federal exclusion);
 *   - 401(k) deferrals: Subject to UI/ETT and SDI, Not Subject to PIT.
 * $5,000 biweekly gross throughout.
 */

const ca = (checkDate: string, deductions: Deduction[]): PaycheckInput => ({
  checkDate,
  payFrequency: 'biweekly',
  earnings: [{ code: 'REG', category: 'regular', amount: 500000 }],
  deductions,
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: 'CA' },
  employer: { stateUnemploymentRate: { CA: 0.03 } },
});

const line = (r: ReturnType<typeof calculatePaycheck>, id: string) => r.taxes.find((t) => t.id === id)!;

const mixed: Deduction[] = [
  { code: 'MED', category: 'section125', amount: 10000 },
  { code: 'HSA', category: 'hsa', amount: 20000 },
  { code: '401K', category: 'deferral_401k', amount: 30000 },
];

describe('California pre-tax deductions', () => {
  for (const checkDate of ['2025-06-13', '2026-06-12']) {
    test(`${checkDate}: SDI and UI exclude the cafeteria premium only`, () => {
      const r = calculatePaycheck(ca(checkDate, mixed));
      assert.equal(line(r, 'CA_DBL_EE').taxableWages, 490000); // 5,000 - 100 section 125
      assert.equal(line(r, 'CA_SUI_ER').taxableWages, 490000);
    });

    test(`${checkDate}: HSA does not reduce PIT wages, unlike federal`, () => {
      const hsa = calculatePaycheck(ca(checkDate, [{ code: 'HSA', category: 'hsa', amount: 20000 }]));
      const none = calculatePaycheck(ca(checkDate, []));
      assert.equal(line(hsa, 'CA_SIT').taxableWages, line(none, 'CA_SIT').taxableWages);
      assert.equal(line(hsa, 'CA_SIT').amount, line(none, 'CA_SIT').amount);
      assert.equal(line(hsa, 'US_FIT').taxableWages, 480000); // federal still excludes HSA
    });

    test(`${checkDate}: section 125, FSA, dependent care and commuter are out of SDI`, () => {
      const r = calculatePaycheck(ca(checkDate, [
        { code: 'MED', category: 'section125', amount: 10000 },
        { code: 'FSA', category: 'fsa', amount: 5000 },
        { code: 'DCAP', category: 'dependent_care', amount: 5000 },
        { code: 'TRN', category: 'commuter', amount: 5000 },
      ]));
      assert.equal(line(r, 'CA_DBL_EE').taxableWages, 475000);
    });
  }
});
