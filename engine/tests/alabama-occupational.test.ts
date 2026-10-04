import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { calculateAlabamaPaycheck } from '../src/alabama/index.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * The 2026-09-28 primary-source pass on data/local/AL-municipalities-2026.json:
 * towns the League survey never listed, and Macon County's county-level
 * fee (Ala. Code 45-44-244.31), which applies only outside the towns that
 * already taxed on 2019-06-10.
 */

const pay = (certificate: Record<string, unknown>): PaycheckInput => ({
  checkDate: '2026-06-15',
  payFrequency: 'biweekly',
  earnings: [{ code: 'REG', category: 'regular', amount: 200000 }], // $2,000
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: 'AL', certificate: { exemptions: 'S', dependents: 0, ...certificate } } as PaycheckInput['workState'],
});

const amountOf = (r: ReturnType<typeof calculatePaycheck>, id: string) => r.taxes.find((t) => t.id === id)?.amount;

describe('Alabama towns missing from the League survey', () => {
  for (const [city, cents] of [
    ['Beaverton', 2000], // 1%, Neumo 01/2026 return
    ['Irondale', 1000], // 0.50% since Ord. 2024-12 (2024-07-02)
    ['Notasulga', 2000], // 1%, Ord. 97-11-01
    ['Tarrant', 1000], // 0.5%, extended past its 2020 sunset
  ] as const) {
    test(`${city}: ${cents} cents on $2,000, no notice`, () => {
      const r = calculatePaycheck(pay({ workCity: city }));
      assert.equal(amountOf(r, 'AL_LOCAL'), cents);
      assert.equal(r.notices, undefined);
    });
  }
});

describe("Macon County's 1% county occupational fee", () => {
  test('unincorporated Macon County: county line only', () => {
    const r = calculatePaycheck(pay({ workCounty: 'Macon' }));
    assert.equal(amountOf(r, 'AL_COUNTY'), 2000);
    assert.equal(amountOf(r, 'AL_LOCAL'), undefined);
  });

  test('"Macon County" spelling also resolves', () => {
    assert.equal(amountOf(calculatePaycheck(pay({ workCounty: 'Macon County' })), 'AL_COUNTY'), 2000);
  });

  test('a Macon County town with no tax of its own (Franklin): county line only', () => {
    const r = calculatePaycheck(pay({ workCity: 'Franklin', workCounty: 'Macon' }));
    assert.equal(amountOf(r, 'AL_COUNTY'), 2000);
    assert.equal(amountOf(r, 'AL_LOCAL'), undefined);
  });

  for (const town of ['Tuskegee', 'Notasulga', 'Shorter']) {
    test(`${town} already taxed on 2019-06-10: town tax only, no county line`, () => {
      const r = calculatePaycheck(pay({ workCity: town, workCounty: 'Macon' }));
      assert.ok(amountOf(r, 'AL_LOCAL'));
      assert.equal(amountOf(r, 'AL_COUNTY'), undefined);
    });
  }

  test('another county: nothing', () => {
    const r = calculatePaycheck(pay({ workCounty: 'Lee' }));
    assert.equal(amountOf(r, 'AL_COUNTY'), undefined);
  });

  test('a Kentucky workCounty named Macon is not charged Alabama\'s fee', () => {
    const r = calculatePaycheck({ ...pay({}), workState: { code: 'KY', certificate: { workCounty: 'Macon' } } as PaycheckInput['workState'] });
    assert.equal(amountOf(r, 'AL_COUNTY'), undefined);
  });
});

describe('the Alabama-specific API carries workCounty through', () => {
  const input = {
    checkDate: '2026-04-15',
    payFrequency: 'semimonthly' as const,
    earnings: { regular: 2600 },
    a4: { exemptionCode: 'S' as const, dependents: 0 },
    federalW4: { filingStatus: 'single' as const },
  };

  test('unincorporated Macon County: countyOccupationalTax at 1%', () => {
    const out = calculateAlabamaPaycheck({ ...input, workCounty: 'Macon' });
    assert.equal(out.alabama.countyOccupationalTax?.county, 'Macon');
    assert.equal(out.alabama.countyOccupationalTax?.rate, 0.01);
    assert.equal(out.alabama.localOccupationalTax, undefined);
  });

  test('Tuskegee in Macon County: city tax, and the explanation says why the county fee does not apply', () => {
    const out = calculateAlabamaPaycheck({ ...input, workCity: 'Tuskegee', workCounty: 'Macon' });
    assert.equal(out.alabama.localOccupationalTax?.rate, 0.03);
    assert.equal(out.alabama.countyOccupationalTax, undefined);
    assert.ok(out.alabama.explanation.some((l) => /2019-06-10/.test(l)));
  });
});
