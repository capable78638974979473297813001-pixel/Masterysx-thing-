import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateAlabamaPaycheck,
  AlabamaInputError,
  formatAlabamaPaystub,
  ALABAMA_SCENARIOS,
  alabamaScenario,
} from '../src/alabama/index.ts';

/**
 * Tests for src/alabama/ — the friendly Alabama-only input/output layer
 * built on top of the general engine's own Alabama rules (already proven
 * against the withholding booklet's worked example in tests/engine.test.ts,
 * describe('Alabama')). These tests are about the LAYER, not the tax
 * arithmetic: does a plain-language input translate to the right engine
 * call, does an invalid input fail loudly, does every scenario in the
 * catalogue actually run.
 */

describe('Alabama input/output layer', () => {
  test('a minimal input calculates without throwing and produces a positive net pay', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-03-13',
      payFrequency: 'weekly',
      earnings: { regular: 620 },
    });
    assert.ok(out.netPay.cents > 0);
    assert.ok(out.netPay.cents < out.grossPay.cents);
    assert.equal(out.grossPay.display, '$620.00');
  });

  test('no A-4 supplied defaults to code "0", zero dependents — the booklet\'s own "zero exemptions" instruction', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-03-13',
      payFrequency: 'weekly',
      earnings: { regular: 620 },
    });
    assert.equal(out.alabama.a4.exemptionCode, '0');
    assert.equal(out.alabama.a4.dependents, 0);
  });

  test('every dollar amount round-trips through the Amount shape consistently', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-03-13',
      payFrequency: 'biweekly',
      earnings: { regular: 3000.5 },
    });
    assert.equal(out.grossPay.cents, Math.round(300050));
    assert.equal(out.grossPay.dollars, 3000.5);
    assert.equal(out.grossPay.display, '$3000.50');
  });

  test('rejects a negative earning rather than silently flipping its sign', () => {
    assert.throws(
      () =>
        calculateAlabamaPaycheck({
          checkDate: '2026-03-13',
          payFrequency: 'weekly',
          earnings: { regular: -500 },
        }),
      AlabamaInputError,
    );
  });

  test('rejects an unknown A-4 exemption code', () => {
    assert.throws(
      () =>
        calculateAlabamaPaycheck({
          checkDate: '2026-03-13',
          payFrequency: 'weekly',
          earnings: { regular: 620 },
          a4: { exemptionCode: 'X' as never },
        }),
      AlabamaInputError,
    );
  });

  test('rejects a checkDate with no matching Alabama ruleset instead of silently using another year\'s rates', () => {
    assert.throws(
      () =>
        calculateAlabamaPaycheck({
          checkDate: '1999-01-01',
          payFrequency: 'weekly',
          earnings: { regular: 620 },
        }),
      AlabamaInputError,
    );
  });

  test('rejects an invalid payFrequency', () => {
    assert.throws(
      () =>
        calculateAlabamaPaycheck({
          checkDate: '2026-03-13',
          payFrequency: 'biannually' as never,
          earnings: { regular: 620 },
        }),
      AlabamaInputError,
    );
  });

  test('the thrown error names the actual problem, not a generic message', () => {
    try {
      calculateAlabamaPaycheck({
        checkDate: '2026-03-13',
        payFrequency: 'weekly',
        earnings: { regular: 620 },
        a4: { dependents: -1 },
      });
      assert.fail('expected AlabamaInputError');
    } catch (err) {
      assert.ok(err instanceof AlabamaInputError);
      assert.ok(err.problems.some((p) => p.includes('dependents')));
    }
  });

  test('a recognised work city produces a local occupational tax line and summary', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-04-15',
      payFrequency: 'weekly',
      earnings: { regular: 1000 },
      workCity: 'Birmingham',
    });
    assert.ok(out.alabama.localOccupationalTax);
    assert.equal(out.alabama.localOccupationalTax?.city, 'Birmingham');
    assert.equal(out.alabama.localOccupationalTax?.rate, 0.01);
    assert.equal(out.alabama.localOccupationalTax?.amount.display, '$10.00');
  });

  test('an unrecognised work city produces no local line and a warning instead of a silent $0', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-04-15',
      payFrequency: 'weekly',
      earnings: { regular: 1000 },
      workCity: 'Montgomery',
    });
    assert.equal(out.alabama.localOccupationalTax, undefined);
    assert.ok(out.warnings.some((w) => w.includes('Montgomery')));
  });

  test('a standalone bonus with no supplemental election warns about over-withholding', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-06-01',
      payFrequency: 'biweekly',
      earnings: { bonus: 5000 },
    });
    assert.ok(out.warnings.some((w) => w.toLowerCase().includes('over-withhold')));
  });

  test('electing the 5% method silences that warning and produces the flat line', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-06-01',
      payFrequency: 'biweekly',
      earnings: { bonus: 5000 },
      employer: { useFivePercentSupplementalRate: true },
    });
    assert.ok(!out.warnings.some((w) => w.toLowerCase().includes('over-withhold')));
    assert.ok(out.raw.some((t) => t.id === 'AL_SIT_SUPP'));
  });

  test('severance without an asserted approval is taxed as ordinary wages and warns', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-09-01',
      payFrequency: 'monthly',
      earnings: { regular: 6000, severance: 18000 },
    });
    assert.ok(out.warnings.some((w) => w.toLowerCase().includes('severance')));
  });

  test('approved severance reduces Alabama tax relative to the same cheque unapproved', () => {
    const approved = calculateAlabamaPaycheck({
      checkDate: '2026-09-01',
      payFrequency: 'monthly',
      earnings: { regular: 6000, severance: 18000 },
      severanceExemption: { approvalOnFile: true },
    });
    const unapproved = calculateAlabamaPaycheck({
      checkDate: '2026-09-01',
      payFrequency: 'monthly',
      earnings: { regular: 6000, severance: 18000 },
    });
    assert.ok(approved.alabama.stateIncomeTax.cents < unapproved.alabama.stateIncomeTax.cents);
  });

  test('exceeding the requested severance beyond what was actually paid is rejected', () => {
    assert.throws(
      () =>
        calculateAlabamaPaycheck({
          checkDate: '2026-09-01',
          payFrequency: 'monthly',
          earnings: { regular: 6000, severance: 5000 },
          severanceExemption: { approvalOnFile: true, exemptThisPeriod: 9000 },
        }),
      AlabamaInputError,
    );
  });

  test('a household worker owes $0 Alabama income tax via employmentCategory', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-05-01',
      payFrequency: 'weekly',
      earnings: { regular: 500 },
      employmentCategory: 'household',
    });
    assert.equal(out.alabama.stateIncomeTax.cents, 0);
  });

  test('a nonresident within the 30-day safe harbor owes $0', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-08-01',
      payFrequency: 'weekly',
      earnings: { regular: 1500 },
      residency: { residenceState: 'GA', daysWorkedInAlabamaThisYear: 12 },
    });
    assert.equal(out.alabama.stateIncomeTax.cents, 0);
  });

  test('a nonresident with no day count supplied is withheld (absence is not a claim of few days) and warns', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-08-01',
      payFrequency: 'weekly',
      earnings: { regular: 1500 },
      residency: { residenceState: 'GA' },
    });
    assert.ok(out.alabama.stateIncomeTax.cents > 0);
    assert.ok(out.warnings.some((w) => w.includes('day count')));
  });

  test('overtime in 2026 is taxed as ordinary wages, with a warning noting the exclusion has expired', () => {
    const withOT = calculateAlabamaPaycheck({
      checkDate: '2026-03-13',
      payFrequency: 'weekly',
      earnings: { regular: 640, overtime: 180 },
    });
    const regularOnly = calculateAlabamaPaycheck({
      checkDate: '2026-03-13',
      payFrequency: 'weekly',
      earnings: { regular: 640 },
    });
    assert.ok(withOT.alabama.stateIncomeTax.cents > regularOnly.alabama.stateIncomeTax.cents);
    assert.ok(withOT.warnings.some((w) => w.toLowerCase().includes('overtime')));
  });

  test('a minister housing allowance is excluded from the federal base but Alabama income tax is still $0 via clergy category', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-07-01',
      payFrequency: 'monthly',
      earnings: { regular: 2800, housingAllowance: 1200 },
      employmentCategory: 'clergy',
    });
    assert.equal(out.alabama.stateIncomeTax.cents, 0);
    // The housing allowance itself must not appear as cash gross pay beyond regular.
    assert.equal(out.grossPay.dollars, 4000);
  });

  test('pre-tax deductions narrow the Alabama taxable base', () => {
    const withDeduction = calculateAlabamaPaycheck({
      checkDate: '2026-06-15',
      payFrequency: 'biweekly',
      earnings: { regular: 3000 },
      deductions: [{ code: '401K', category: 'deferral_401k', amount: 200 }],
    });
    const without = calculateAlabamaPaycheck({
      checkDate: '2026-06-15',
      payFrequency: 'biweekly',
      earnings: { regular: 3000 },
    });
    assert.ok(withDeduction.alabamaTaxableWages.cents < without.alabamaTaxableWages.cents);
  });

  test('formatAlabamaPaystub renders text containing the net pay figure', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-03-13',
      payFrequency: 'weekly',
      earnings: { regular: 620 },
    });
    const text = formatAlabamaPaystub(out);
    assert.ok(text.includes(out.netPay.display));
    assert.ok(text.includes('ALABAMA'));
  });

  test('employer.unemploymentRate overrides the published new-employer rate', () => {
    const out = calculateAlabamaPaycheck({
      checkDate: '2026-06-15',
      payFrequency: 'biweekly',
      earnings: { regular: 3200 },
      workCity: 'Gadsden',
      employer: { unemploymentRate: 0.014 },
      ytd: { alabamaUnemployment: 7200 },
    });
    assert.equal(out.alabama.unemploymentEmployer?.display, '$11.20');
    assert.ok(!out.warnings.some((w) => w.includes('new-employer rate')));
  });

  describe('scenario catalogue', () => {
    test('every scenario runs end to end without throwing', () => {
      for (const scenario of ALABAMA_SCENARIOS) {
        const out = calculateAlabamaPaycheck(scenario.input);
        assert.ok(out.netPay.cents !== undefined, `${scenario.id} produced no net pay`);
      }
    });

    test('scenario ids are unique', () => {
      const ids = ALABAMA_SCENARIOS.map((s) => s.id);
      assert.equal(new Set(ids).size, ids.length);
    });

    test('alabamaScenario() looks up by id and throws on an unknown one', () => {
      assert.equal(alabamaScenario('plain-single').id, 'plain-single');
      assert.throws(() => alabamaScenario('does-not-exist'));
    });

    test('the household and agricultural scenarios actually exempt AL income tax', () => {
      const household = calculateAlabamaPaycheck(alabamaScenario('household-employee').input);
      const agricultural = calculateAlabamaPaycheck(alabamaScenario('agricultural-worker').input);
      assert.equal(household.alabama.stateIncomeTax.cents, 0);
      assert.equal(agricultural.alabama.stateIncomeTax.cents, 0);
    });

    test('the safe-harbor scenario is $0 and the over-threshold scenario is not', () => {
      const withinHarbor = calculateAlabamaPaycheck(alabamaScenario('nonresident-safe-harbor').input);
      const overThreshold = calculateAlabamaPaycheck(alabamaScenario('nonresident-over-threshold').input);
      assert.equal(withinHarbor.alabama.stateIncomeTax.cents, 0);
      assert.ok(overThreshold.alabama.stateIncomeTax.cents > 0);
    });

    test('the partial-allocation scenario taxes less than the full-wages equivalent would', () => {
      const partial = calculateAlabamaPaycheck(alabamaScenario('nonresident-partial-allocation').input);
      const fullyAllocated = calculateAlabamaPaycheck({
        ...alabamaScenario('nonresident-partial-allocation').input,
        residency: { residenceState: 'TN', daysWorkedInAlabamaThisYear: 90 },
      });
      assert.ok(partial.alabama.stateIncomeTax.cents < fullyAllocated.alabama.stateIncomeTax.cents);
    });
  });
});
