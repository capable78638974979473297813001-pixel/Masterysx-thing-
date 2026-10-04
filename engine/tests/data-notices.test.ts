import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { allKYJurisdictions } from '../src/registry.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * Lower-confidence rates and unmodelled elections are disclosed in the
 * data files; these tests pin that a calculation touching one also says
 * so in its result, where an API caller will actually see it.
 */

const base = (state: string, certificate: Record<string, unknown> = {}): PaycheckInput => ({
  checkDate: '2026-06-15',
  payFrequency: 'biweekly',
  earnings: [{ code: 'REG', category: 'regular', amount: 250000 }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: state, certificate } as PaycheckInput['workState'],
});

describe('data-quality notices on the paycheck result', () => {
  test('a primary-sourced paycheck carries no notices', () => {
    const r = calculatePaycheck(base('PA'));
    assert.equal(r.notices, undefined);
  });

  test('an Alabama city with only the League survey behind its rate is marked survey-sourced', () => {
    const r = calculatePaycheck(base('AL', { workCity: 'Gadsden', exemptions: 'S', dependents: 0 }));
    const line = r.taxes.find((t) => t.id === 'AL_LOCAL')!;
    assert.ok(line, 'expected an AL_LOCAL line');
    assert.equal(line.dataQuality?.tier, 'secondary_source');
    assert.deepEqual(r.notices?.map((n) => n.taxId), ['AL_LOCAL']);
  });

  test("an Alabama city confirmed from its own form carries no notice (Birmingham's return: 1%)", () => {
    const r = calculatePaycheck(base('AL', { workCity: 'Birmingham', exemptions: 'S', dependents: 0 }));
    const line = r.taxes.find((t) => t.id === 'AL_LOCAL')!;
    assert.equal(line.amount, 2500);
    assert.equal(line.dataQuality, undefined);
    assert.equal(r.notices, undefined);
  });

  test("Tuskegee uses its own form's 3% and says the League's 2% disagrees", () => {
    const r = calculatePaycheck(base('AL', { workCity: 'Tuskegee', exemptions: 'S', dependents: 0 }));
    const line = r.taxes.find((t) => t.id === 'AL_LOCAL')!;
    assert.equal(line.amount, 7500);
    assert.equal(line.dataQuality?.tier, 'conflicting_sources');
    assert.match(line.dataQuality!.note, /2%/);
  });

  test('a Kentucky line with an inferred rate is marked inferred', () => {
    const inferred = allKYJurisdictions('2026-06-15').find((e) => e.wageRateStatus?.startsWith('inferred'))!;
    assert.ok(inferred, 'expected at least one inferred KY entry');
    const r = calculatePaycheck(base('KY', { workCity: inferred.name }));
    const line = r.taxes.find((t) => t.id === 'KY_LOCAL')!;
    assert.equal(line.dataQuality?.tier, 'inferred');
    assert.match(r.notices![0].note, new RegExp(inferred.name));
  });

  test('an Arkansas low-income election outside DFA\'s tables is flagged, not silently computed', () => {
    // Daily pay has no low-income table: the Formula Method applies, with a notice.
    const daily = calculatePaycheck({ ...base('AR', { exemptions: 1, lowIncomeElection: true, filingStatus: 'single', dependents: 0 }), payFrequency: 'daily', earnings: [{ code: 'REG', category: 'regular', amount: 5000 }] });
    const n = daily.notices!.find((x) => x.taxId === 'AR_SIT')!;
    assert.equal(n.tier, 'not_modelled');
    assert.match(n.note, /no daily table/);
  });
});

describe('New Hampshire UI new-employer rate', () => {
  const nh = (checkDate: string, employer?: PaycheckInput['employer']) =>
    calculatePaycheck({ ...base('NH'), checkDate, ...(employer ? { employer } : {}) });
  test('confirmed through Q3 2026 (NHES WebTax notice): no notice', () => {
    assert.equal(nh('2026-06-15').notices, undefined);
    const r = nh('2026-09-25');
    assert.equal(r.taxes.find((t) => t.id === 'NH_SUI_ER')?.amount, 4250); // $2,500 x 1.7%
    assert.equal(r.notices, undefined);
  });
  test('after 2026-09-30 the rate is still used but flagged until NHES publishes Q4', () => {
    const r = nh('2026-10-09');
    assert.equal(r.taxes.find((t) => t.id === 'NH_SUI_ER')?.amount, 4250);
    assert.equal(r.notices?.[0].taxId, 'NH_SUI_ER');
    assert.equal(r.notices?.[0].tier, 'inferred');
  });
  test("an employer's own assigned rate needs no notice", () => {
    const r = nh('2026-10-09', { stateUnemploymentRate: { NH: 0.012 } } as PaycheckInput['employer']);
    assert.equal(r.notices, undefined);
  });
});
