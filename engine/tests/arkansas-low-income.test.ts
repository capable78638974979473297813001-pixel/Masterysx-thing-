import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * Arkansas AR4EC Line 5: DFA's 2026 Low Income Tax Tables. Expected values
 * are read straight off the published PDF
 * (Withholding-Tax-Tables-for-Low-Income.pdf, Effective 01/01/2026).
 */

const paycheck = (payFrequency: string, dollarsPerPeriod: number, certificate: Record<string, unknown>): PaycheckInput => ({
  checkDate: '2026-06-15',
  payFrequency: payFrequency as PaycheckInput['payFrequency'],
  earnings: [{ code: 'REG', category: 'regular', amount: Math.round(dollarsPerPeriod * 100) }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: 'AR', certificate } as PaycheckInput['workState'],
});
const ar = (input: PaycheckInput) => calculatePaycheck(input).taxes.find((t) => t.id === 'AR_SIT')!;
const elect = (filingStatus: string, dependents: number, exemptions = 1) => ({ lowIncomeElection: true, filingStatus, dependents, exemptions });

describe('Arkansas low-income withholding tables (AR4EC Line 5)', () => {
  test('single, bi-weekly, $600: row 596.16–600.00 (page 2)', () => {
    assert.equal(ar(paycheck('biweekly', 600, elect('single', 0))).amount, 341);
    assert.equal(ar(paycheck('biweekly', 600, elect('single', 1))).amount, 230);
    assert.equal(ar(paycheck('biweekly', 600, elect('single', 4))).amount, 0);
  });

  test('married, 2+ dependents, monthly, $2,500: row 2491.68–2500.00 (page 21)', () => {
    assert.equal(ar(paycheck('monthly', 2500, elect('mfj', 2, 4))).amount, 617);
    assert.equal(ar(paycheck('monthly', 2500, elect('mfj', 3, 5))).amount, 375);
  });

  test('head of household, 1 or no dependents, semi-monthly, $1,000: row 995.84–1000.00 (page 7)', () => {
    assert.equal(ar(paycheck('semimonthly', 1000, elect('hoh', 0, 2))).amount, 1496);
    assert.equal(ar(paycheck('semimonthly', 1000, elect('hoh', 1, 3))).amount, 1375);
  });

  test('a wage in the zero band withholds nothing', () => {
    assert.equal(ar(paycheck('weekly', 250, elect('single', 0))).amount, 0);
  });

  test('the table withholds less than the Formula Method in its range', () => {
    const table = ar(paycheck('biweekly', 600, elect('single', 0))).amount;
    const formula = ar(paycheck('biweekly', 600, { exemptions: 1 })).amount;
    assert.ok(table < formula, `${table} < ${formula}`);
  });

  test('above the top band the election no longer applies: Formula Method, no notice', () => {
    const r = calculatePaycheck(paycheck('weekly', 400, elect('single', 0)));
    const line = r.taxes.find((t) => t.id === 'AR_SIT')!;
    assert.equal(line.amount, ar(paycheck('weekly', 400, { exemptions: 1 })).amount);
    assert.match(line.detail!, /above the weekly low-income table's top band/);
    assert.equal(r.notices, undefined);
  });

  test('7+ dependents are outside the tables: Formula Method with a notice', () => {
    const r = calculatePaycheck(paycheck('biweekly', 600, elect('single', 7, 8)));
    assert.equal(r.notices?.[0].tier, 'not_modelled');
  });

  test('the election needs a filing status and dependent count', () => {
    assert.throws(() => calculatePaycheck(paycheck('biweekly', 600, { lowIncomeElection: true, exemptions: 1 })), /filingStatus/);
    assert.throws(() => calculatePaycheck(paycheck('biweekly', 600, { lowIncomeElection: true, filingStatus: 'single', exemptions: 1 })), /dependents/);
  });
});
