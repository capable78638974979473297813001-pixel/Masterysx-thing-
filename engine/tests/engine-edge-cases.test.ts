import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { CannotComputeError } from '../src/registry.ts';

const input = (o: Record<string, unknown> = {}) => ({
  checkDate: '2026-06-15',
  payFrequency: 'biweekly',
  earnings: [{ code: 'REG', category: 'regular', amount: 300000 }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: 'OH' },
  ...o,
}) as never;

describe('paychecks that do not add up', () => {
  test('a normal paycheck carries no warnings', () => {
    assert.equal(calculatePaycheck(input()).warnings, undefined);
  });
  test('deductions bigger than the pay say so instead of silently going negative', () => {
    const r = calculatePaycheck(input({ deductions: [{ code: 'P', category: null, amount: 900000 }] }));
    assert.ok(r.netPay < 0);
    assert.equal(r.warnings?.length, 1);
    assert.match(r.warnings![0]!, /more than this paycheck/);
  });
  test('a withholding bigger than the pay says so too', () => {
    const w4 = { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 999999 };
    assert.ok(calculatePaycheck(input({ federalW4: w4 })).warnings);
  });
});

describe('a state with no published method for the pay frequency', () => {
  test('refuses with a typed error that names the reason', () => {
    assert.throws(() => calculatePaycheck(input({ payFrequency: 'quarterly' })), (e: unknown) =>
      e instanceof CannotComputeError && /cannot compute/i.test(e.message));
  });
});
