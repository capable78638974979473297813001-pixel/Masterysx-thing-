import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { futa } from '../src/taxes/federal.ts';
import { atLeastZero, dollars, overThreshold, roundHalfUp, underCap } from '../src/money.ts';
import { capElectiveDeferrals, makeTaxableWagesFn } from '../src/wages.ts';
import type { Deduction, Earning, PaycheckInput } from '../src/types.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every expected value below was computed by hand from the published
 * worksheet before the code was run, not captured from the implementation.
 * A golden file regenerated from its own engine proves nothing.
 */

function input(overrides: Partial<PaycheckInput> = {}): PaycheckInput {
  return {
    checkDate: '2026-06-15',
    payFrequency: 'biweekly',
    earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single',
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    ...overrides,
  };
}

function amountOf(result: ReturnType<typeof calculatePaycheck>, id: string) {
  const line = result.taxes.find((t) => t.id === id);
  assert.ok(line, `expected a tax line with id ${id}`);
  return line.amount;
}

describe('money primitives', () => {
  test('underCap stops at the wage base', () => {
    // $180,000 YTD against a $184,500 base leaves $4,500 of room.
    assert.equal(
      underCap(dollars(10_000), dollars(180_000), dollars(184_500)),
      dollars(4_500),
    );
  });

  test('underCap returns zero once the base is exhausted', () => {
    assert.equal(underCap(dollars(10_000), dollars(200_000), dollars(184_500)), 0);
  });

  test('overThreshold isolates only the portion above the trigger', () => {
    // $195k YTD + $10k this cheque = $205k; $5k sits above $200k.
    assert.equal(
      overThreshold(dollars(10_000), dollars(195_000), dollars(200_000)),
      dollars(5_000),
    );
  });

  describe('BUG FIX: NaN used to pass through silently — atLeastZero returned 0, roundHalfUp returned NaN', () => {
    // Found auditing the engine for the same "malformed input, no error"
    // bug class already fixed for booleans (resolveCertBoolean): dozens of
    // call sites across taxes/state.ts read a numeric certificate field as
    // `Number(cert.someField ?? 0)`, which produces NaN for anything
    // Number() can't parse rather than throwing. NaN then reached these two
    // universal arithmetic primitives — every tax line in this engine
    // passes through at least one of them. atLeastZero's `cents > 0 ? … :
    // 0` is false for NaN either way, so it silently returned 0: a
    // malformed certificate.exemptions could make a whole state's income
    // tax line report a confident $0 with no error. roundHalfUp's `raw >=
    // 0` is likewise false for NaN, so it took the false branch and
    // returned NaN itself — not silently wrong, but not caught either,
    // until it serialized to JSON as `null`. Both now throw immediately.
    test('atLeastZero(NaN) throws instead of silently returning 0', () => {
      assert.throws(() => atLeastZero(NaN), /atLeastZero\(NaN\)/);
    });

    test('roundHalfUp(NaN) throws instead of silently returning NaN', () => {
      assert.throws(() => roundHalfUp(NaN), /roundHalfUp\(NaN\)/);
    });

    test('a malformed numeric certificate field now throws end to end instead of producing a confident $0', () => {
      // Reproduces the exact live failure this fix closes: Wisconsin's own
      // income tax formula subtracts exemptions x $400 from annualized net
      // wages via atLeastZero() — a non-numeric certificate.exemptions used
      // to make WI_SIT silently report $0 (with a detail string reading
      // "less $NaN.NaN exemptions" that nothing forced a caller to notice).
      assert.throws(
        () =>
          calculatePaycheck(
            input({
              workState: { code: 'WI', certificate: { exemptions: 'two' } },
            }),
          ),
        /atLeastZero\(NaN\)/,
      );
    });

    test('Infinity is caught too, not just NaN', () => {
      assert.throws(() => atLeastZero(Infinity - Infinity), /atLeastZero\(NaN\)/);
      assert.throws(() => roundHalfUp(1 / 0), /roundHalfUp\(Infinity\)/);
    });
  });
});

describe('taxable wage bases diverge per tax', () => {
  const earnings: Earning[] = [
    { code: 'REG', category: 'regular', amount: dollars(3000) },
  ];
  const deductions: Deduction[] = [
    { code: 'MED', category: 'section125', amount: dollars(100) },
    { code: '401K', category: 'deferral_401k', amount: dollars(200) },
    { code: 'UNION', category: null, amount: dollars(25) },
  ];

  const wagesFor = makeTaxableWagesFn(earnings, deductions);

  test('federal income tax excludes both the cafeteria plan and the deferral', () => {
    assert.equal(
      wagesFor(['section125', 'deferral_401k']),
      dollars(2700),
    );
  });

  test('FICA excludes the cafeteria plan but taxes the deferral', () => {
    assert.equal(wagesFor(['section125']), dollars(2900));
  });

  test('post-tax deductions never reduce any base', () => {
    assert.equal(wagesFor([]), dollars(3000));
  });
});

describe('capElectiveDeferrals — IRC 402(g)/457/SIMPLE annual limits', () => {
  // 2026 figures: section402gAggregate $24,500 (401k+403b combined),
  // deferral457 $24,500 (separate), simple $17,000 (separate, lower).
  const LIMITS = { section402gAggregate: 24500, deferral457: 24500, simple: 17000 };

  test('under the limit: passed through unchanged', () => {
    const deductions: Deduction[] = [
      { code: '401K', category: 'deferral_401k', amount: dollars(1000) },
    ];
    assert.deepEqual(capElectiveDeferrals(deductions, undefined, LIMITS), deductions);
  });

  test('exactly at the limit (with prior YTD): still passed through unchanged', () => {
    const deductions: Deduction[] = [
      { code: '401K', category: 'deferral_401k', amount: dollars(500) },
    ];
    const ytd = { section402gAggregate: dollars(24000) };
    assert.deepEqual(capElectiveDeferrals(deductions, ytd, LIMITS), deductions);
  });

  test('a single check that alone exceeds the annual limit splits into pretax + _OVER_LIMIT post-tax', () => {
    // The exact case found during manual verification: $40,000 in one
    // check against a $24,500 limit, no prior YTD.
    const deductions: Deduction[] = [
      { code: '401K', category: 'deferral_401k', amount: dollars(40000) },
    ];
    const result = capElectiveDeferrals(deductions, undefined, LIMITS);
    assert.deepEqual(result, [
      { code: '401K', category: 'deferral_401k', amount: dollars(24500) },
      { code: '401K_OVER_LIMIT', category: null, amount: dollars(15500) },
    ]);
  });

  test('prior YTD contributions shrink the room left this period', () => {
    // $23,000 already contributed this year at this employer; a further
    // $3,000 this period only has $1,500 of room left.
    const deductions: Deduction[] = [
      { code: '401K', category: 'deferral_401k', amount: dollars(3000) },
    ];
    const ytd = { section402gAggregate: dollars(23000) };
    const result = capElectiveDeferrals(deductions, ytd, LIMITS);
    assert.deepEqual(result, [
      { code: '401K', category: 'deferral_401k', amount: dollars(1500) },
      { code: '401K_OVER_LIMIT', category: null, amount: dollars(1500) },
    ]);
  });

  test('401(k) and 403(b) share ONE combined limit, not two separate ones', () => {
    // $15,000 to each in the same period = $30,000 combined, $5,500 over
    // the shared $24,500 limit — split proportionally by processing order.
    const deductions: Deduction[] = [
      { code: '401K', category: 'deferral_401k', amount: dollars(15000) },
      { code: '403B', category: 'deferral_403b', amount: dollars(15000) },
    ];
    const result = capElectiveDeferrals(deductions, undefined, LIMITS);
    assert.deepEqual(result, [
      { code: '401K', category: 'deferral_401k', amount: dollars(15000) },
      { code: '403B', category: 'deferral_403b', amount: dollars(9500) },
      { code: '403B_OVER_LIMIT', category: null, amount: dollars(5500) },
    ]);
  });

  test('457(b) has its OWN separate limit, not aggregated with 401(k)', () => {
    // $24,500 to a 401(k) AND $24,500 to a 457(b) in the same period —
    // both fully at their own limit, neither reduces the other.
    const deductions: Deduction[] = [
      { code: '401K', category: 'deferral_401k', amount: dollars(24500) },
      { code: '457', category: 'deferral_457', amount: dollars(24500) },
    ];
    assert.deepEqual(capElectiveDeferrals(deductions, undefined, LIMITS), deductions);
  });

  test('SIMPLE plans use their own separate, lower limit', () => {
    const deductions: Deduction[] = [
      { code: 'SIMPLE', category: 'deferral_simple', amount: dollars(18000) },
    ];
    const result = capElectiveDeferrals(deductions, undefined, LIMITS);
    assert.deepEqual(result, [
      { code: 'SIMPLE', category: 'deferral_simple', amount: dollars(17000) },
      { code: 'SIMPLE_OVER_LIMIT', category: null, amount: dollars(1000) },
    ]);
  });

  test('end to end: an over-limit 401(k) deduction is still fully FICA-taxable but only partly income-tax-exempt', () => {
    const r = calculatePaycheck(input({
      earnings: [{ code: 'REG', category: 'regular', amount: dollars(50000) }],
      deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(40000) }],
    }));
    // $50,000 - $24,500 (the capped exempt portion) = $25,500 federal taxable.
    assert.equal(r.taxes.find((t) => t.id === 'US_FIT')?.taxableWages, dollars(25500));
    // FICA is unaffected by the cap — deferrals are always FICA wages, capped or not.
    assert.equal(r.taxes.find((t) => t.id === 'US_SS_EE')?.taxableWages, dollars(50000));
    // Net pay is unaffected: the full $40,000 still leaves the paycheck either way.
    assert.equal(r.netPay, r.grossPay - dollars(40000) - r.employeeTaxTotal);
  });
});

describe('federal income tax — Pub 15-T Worksheet 1A', () => {
  test('single, biweekly, $3,000, no adjustments', () => {
    // annual 78,000 − 8,600 = 69,400 → 22% bracket over 57,900, base 5,800
    // 5,800 + 0.22 × 11,500 = 8,330/yr ÷ 26 = 320.38
    const r = calculatePaycheck(input());
    assert.equal(amountOf(r, 'US_FIT'), dollars(320.38));
  });

  test('nonresident alien: Pub 15-T Table 2 adds a fixed amount to wages before annualizing', () => {
    // Same $3,000 biweekly base as above, plus w4.nonresidentAlien:true.
    // Table 2 biweekly = $619.20. Adjusted per-period wages: 3,000+619.20=
    // 3,619.20 -> annual 3,619.20x26=94,099.20 - 8,600 standard adj =
    // 85,499.20 -> 22% bracket over 57,900, base 5,800: 5,800 + 0.22 x
    // 27,599.20 = 5,800+6,071.824 = 11,871.824/yr -> /26 = 456.6086... ->
    // $456.61 (vs. $320.38 for the same wages without the adjustment).
    const r = calculatePaycheck(
      input({
        federalW4: {
          filingStatus: 'single',
          multipleJobs: false,
          dependentCredit: 0,
          otherIncome: 0,
          deductions: 0,
          extraWithholding: 0,
          nonresidentAlien: true,
        },
      }),
    );
    assert.equal(amountOf(r, 'US_FIT'), dollars(456.61));
  });

  test('Step 2 checkbox switches to the multiple-jobs schedule', () => {
    // No 8,600 adjustment; 78,000 → 24% bracket over 60,900, base 8,983
    // 8,983 + 0.24 × 17,100 = 13,087/yr ÷ 26 = 503.35
    const r = calculatePaycheck(
      input({
        federalW4: { ...input().federalW4, multipleJobs: true },
      }),
    );
    assert.equal(amountOf(r, 'US_FIT'), dollars(503.35));
  });

  test('dependent credit reduces withholding per period', () => {
    // 320.38 − (2,200 ÷ 26 = 84.62) = 235.76
    const r = calculatePaycheck(
      input({
        federalW4: { ...input().federalW4, dependentCredit: dollars(2200) },
      }),
    );
    assert.equal(amountOf(r, 'US_FIT'), dollars(235.76));
  });

  test('credits cannot drive withholding negative', () => {
    const r = calculatePaycheck(
      input({
        federalW4: { ...input().federalW4, dependentCredit: dollars(99_000) },
      }),
    );
    assert.equal(amountOf(r, 'US_FIT'), 0);
  });

  test('extra withholding is added after credits', () => {
    const r = calculatePaycheck(
      input({
        federalW4: { ...input().federalW4, extraWithholding: dollars(50) },
      }),
    );
    assert.equal(amountOf(r, 'US_FIT'), dollars(370.38));
  });

  test('exempt W-4 withholds nothing for income tax but FICA still applies', () => {
    const r = calculatePaycheck(
      input({ federalW4: { ...input().federalW4, exempt: true } }),
    );
    assert.equal(amountOf(r, 'US_FIT'), 0);
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(186));
  });

  test('BUG FIX: w4.exempt: "false" (a string) throws rather than being silently treated as true', () => {
    // w4.exempt is typed `boolean` in FederalW4, but that only binds a
    // TypeScript caller — this engine is also served as a JSON API
    // (supabase/functions/calculate-paycheck), where nothing stops a
    // string "false" arriving on the wire. Before this fix, `if
    // (w4.exempt)` would have zeroed FEDERAL income tax on every such
    // paycheck — the highest-stakes instance of a bug class already fixed
    // for certificate.exempt/nonresident in taxes/state.ts.
    assert.throws(
      () =>
        calculatePaycheck(
          input({ federalW4: { ...input().federalW4, exempt: 'false' as unknown as boolean } }),
        ),
      /Unrecognized certificate\.exempt/,
    );
  });

  test('BUG FIX: w4.nonresidentAlien: "false" (a string) throws the same way', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            federalW4: { ...input().federalW4, nonresidentAlien: 'false' as unknown as boolean },
          }),
        ),
      /Unrecognized certificate\.nonresidentAlien/,
    );
  });

  test('low wages land in the 0% bracket', () => {
    const r = calculatePaycheck(
      input({
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
      }),
    );
    // 200 × 26 = 5,200 annual, below the 8,600 adjustment → base of 0
    assert.equal(amountOf(r, 'US_FIT'), 0);
  });

  test('married filing separately uses the single schedule', () => {
    const single = calculatePaycheck(input());
    const mfs = calculatePaycheck(
      input({
        federalW4: { ...input().federalW4, filingStatus: 'married_separate' },
      }),
    );
    assert.equal(amountOf(mfs, 'US_FIT'), amountOf(single, 'US_FIT'));
  });

  // OBBBA's "no tax on tips" / "no tax on overtime" deductions (P.L.
  // 119-21): the 2026 Form W-4's own Step 4(b) Deductions Worksheet has the
  // employee estimate qualified tips/overtime/car-loan-interest and fold
  // the total into ONE number entered on Step 4(b) of the actual W-4 —
  // this engine's existing federalW4.deductions field. No new mechanism
  // needed; this proves the existing field actually carries it through.
  test('a caller-supplied Step 4(b) deduction (standing in for an OBBBA tips/overtime worksheet result) reduces the annual base dollar-for-dollar', () => {
    const withoutDeduction = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1200) }],
      }),
    );
    // $8,000 standing in for the W-4 worksheet's own Line 15 result (e.g.
    // an $8,000 qualified-tips estimate, no other adjustments, standard
    // deduction taken — worksheet Line 2 = Line 15 in that case).
    const withDeduction = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1200) }],
        federalW4: { ...input().federalW4, deductions: dollars(8000) },
      }),
    );
    assert.ok(
      amountOf(withDeduction, 'US_FIT') < amountOf(withoutDeduction, 'US_FIT'),
      'a larger Step 4(b) deduction must reduce federal withholding',
    );
    // Independently confirm it's exactly the annualize→bracket→divide
    // path doing the work by reproducing the "with deduction" figure a
    // second way: subtracting $8,000 straight from otherIncome instead of
    // adding it as a deduction lands on the same annual taxable base
    // (Step 1's own 1e−1h arithmetic doesn't care which side of the
    // subtraction a dollar comes from), and therefore the same withholding.
    const viaNegativeOtherIncome = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1200) }],
        federalW4: { ...input().federalW4, otherIncome: -dollars(8000) },
      }),
    );
    assert.equal(amountOf(withDeduction, 'US_FIT'), amountOf(viaNegativeOtherIncome, 'US_FIT'));
  });
});

describe('FICA', () => {
  test('Social Security and Medicare on an uncapped cheque', () => {
    const r = calculatePaycheck(input());
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(186)); // 3,000 × 6.2%
    assert.equal(amountOf(r, 'US_MED_EE'), dollars(43.5)); // 3,000 × 1.45%
    assert.equal(amountOf(r, 'US_SS_ER'), dollars(186)); // employer matches
  });

  test('Social Security stops at the 2026 wage base', () => {
    // 180,000 YTD leaves 4,500 of room → 4,500 × 6.2% = 279.00
    const r = calculatePaycheck(
      input({
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(10_000) }],
        ytd: { socialSecurity: dollars(180_000), medicare: dollars(180_000), futa: dollars(7000) },
      }),
    );
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(279));
    // Medicare has no cap, so it keeps running on the full 10,000.
    assert.equal(amountOf(r, 'US_MED_EE'), dollars(145));
  });

  test('Additional Medicare applies only above $200,000', () => {
    const r = calculatePaycheck(
      input({
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(10_000) }],
        ytd: { socialSecurity: dollars(184_500), medicare: dollars(195_000), futa: dollars(7000) },
      }),
    );
    assert.equal(amountOf(r, 'US_MED_ADDL'), dollars(45)); // 5,000 × 0.9%
    // Employer never matches the surtax.
    assert.equal(
      r.taxes.filter((t) => t.id === 'US_MED_ADDL' && t.payer === 'employer').length,
      0,
    );
  });

  test('no Additional Medicare line below the threshold', () => {
    const r = calculatePaycheck(input());
    assert.equal(r.taxes.some((t) => t.id === 'US_MED_ADDL'), false);
  });

  test('401(k) deferral does not reduce the FICA base', () => {
    const r = calculatePaycheck(
      input({
        deductions: [
          { code: '401K', category: 'deferral_401k', amount: dollars(500) },
        ],
      }),
    );
    // Still 3,000 × 6.2%, unchanged by the deferral.
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(186));
    // But federal income tax does drop.
    assert.ok(amountOf(r, 'US_FIT') < dollars(320.38));
  });
});

describe('FUTA', () => {
  test('charged on the first $7,000 only', () => {
    const r = calculatePaycheck(input());
    assert.equal(amountOf(r, 'US_FUTA'), dollars(18)); // 3,000 × 0.6%
  });

  test('zero once the wage base is met', () => {
    const r = calculatePaycheck(
      input({ ytd: { socialSecurity: 0, medicare: 0, futa: dollars(7000) } }),
    );
    assert.equal(amountOf(r, 'US_FUTA'), 0);
  });

  test('partial on the cheque that crosses the base', () => {
    // 6,500 YTD leaves 500 → 500 × 0.6% = 3.00
    const r = calculatePaycheck(
      input({ ytd: { socialSecurity: 0, medicare: 0, futa: dollars(6500) } }),
    );
    assert.equal(amountOf(r, 'US_FUTA'), dollars(3));
  });
});

describe('supplemental wages — Pub 15 flat-rate method', () => {
  const bonus = (amount: number) => ({
    code: 'BONUS',
    category: 'supplemental' as const,
    amount: dollars(amount),
  });

  test('a separate bonus check withholds a flat 22% and no bracket tax', () => {
    const r = calculatePaycheck(input({ earnings: [bonus(5000)] }));
    assert.equal(amountOf(r, 'US_FIT_SUPP'), dollars(1100)); // 5,000 × 22%
    // No regular wages, so the annualize/bracket line is zero.
    assert.equal(amountOf(r, 'US_FIT'), 0);
    // Supplemental wages are still ordinary wages for FICA.
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(310)); // 5,000 × 6.2%
  });

  test('regular and supplemental wages on one cheque are taxed on separate paths', () => {
    const r = calculatePaycheck(
      input({
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(3000) },
          bonus(2000),
        ],
      }),
    );
    // Regular path unchanged: 3,000 biweekly → 320.38 (as in the base fixture).
    assert.equal(amountOf(r, 'US_FIT'), dollars(320.38));
    assert.equal(amountOf(r, 'US_FIT_SUPP'), dollars(440)); // 2,000 × 22%
    // Both federal lines plus FICA on the full 5,000 flow into the total.
    // 320.38 + 440.00 + SS 310.00 + Medicare 72.50 = 1,142.88
    assert.equal(r.employeeTaxTotal, dollars(1142.88));
  });

  test('a bonus that crosses the Social Security wage base — the first fixture', () => {
    // $180,000 YTD leaves $4,500 of SS room; a $10,000 bonus is taxed for SS
    // on that $4,500 only, while supplemental FIT applies to the whole bonus.
    const r = calculatePaycheck(
      input({
        earnings: [bonus(10_000)],
        ytd: {
          socialSecurity: dollars(180_000),
          medicare: dollars(180_000),
          futa: dollars(7000),
        },
      }),
    );
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(279)); // 4,500 × 6.2%
    assert.equal(amountOf(r, 'US_MED_EE'), dollars(145)); // 10,000 × 1.45%, uncapped
    assert.equal(amountOf(r, 'US_FIT_SUPP'), dollars(2200)); // 10,000 × 22%
  });

  test('cumulative supplemental wages above $1M trigger the mandatory 37%', () => {
    // $995,000 supplemental YTD + a $10,000 bonus: $5,000 sits below the $1M
    // line (22%) and $5,000 above it (37%).
    const r = calculatePaycheck(
      input({
        earnings: [bonus(10_000)],
        ytd: {
          socialSecurity: dollars(184_500),
          medicare: dollars(995_000),
          futa: dollars(7000),
          supplemental: dollars(995_000),
        },
      }),
    );
    // 5,000 × 22% + 5,000 × 37% = 1,100 + 1,850 = 2,950.00
    assert.equal(amountOf(r, 'US_FIT_SUPP'), dollars(2950));
  });

  test('no supplemental earnings means no supplemental line at all', () => {
    const r = calculatePaycheck(input());
    assert.equal(r.taxes.some((t) => t.id === 'US_FIT_SUPP'), false);
  });

  test('BUG FIX: pretax deductions exceeding regular wages spill over onto the supplemental base too', () => {
    // $500 regular wages, a $2,000 401(k) deferral, and a $5,000 bonus.
    // Combined taxable = 500 + 5,000 - 2,000 = 3,500. Before this fix,
    // federalSupplementalTax() taxed the raw, un-reduced $5,000 bonus
    // (since pretax was applied only against the $500 regular side, with
    // the $1,500 excess silently discarded rather than spilling onto the
    // bonus) — $1,100 instead of the correct $770, a $330 over-withhold.
    const r = calculatePaycheck(
      input({
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(500) },
          bonus(5000),
        ],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(2000) }],
      }),
    );
    assert.equal(amountOf(r, 'US_FIT'), 0); // regular side already correctly zero
    assert.equal(amountOf(r, 'US_FIT_SUPP'), dollars(770)); // 3,500 × 22%, not 5,000 × 22% = 1,100
  });

  test('pretax spillover floors at $0 when pretax deductions exceed the ENTIRE combined base', () => {
    // $500 regular + $1,000 bonus = $1,500 combined, but a $9,000 pretax
    // deduction exceeds even that — both regular AND supplemental should
    // be $0, not a negative figure silently clamped somewhere unexpected.
    const r = calculatePaycheck(
      input({
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(500) },
          bonus(1000),
        ],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(9000) }],
      }),
    );
    assert.equal(amountOf(r, 'US_FIT'), 0);
    assert.equal(amountOf(r, 'US_FIT_SUPP'), 0);
  });

  test('an exempt W-4 withholds nothing on supplemental wages either', () => {
    const r = calculatePaycheck(
      input({
        earnings: [bonus(5000)],
        federalW4: { ...input().federalW4, exempt: true },
      }),
    );
    assert.equal(amountOf(r, 'US_FIT_SUPP'), 0);
  });
});

describe('Pennsylvania', () => {
  const pa = { workState: { code: 'PA' } };

  test('flat 3.07% with no allowances', () => {
    const r = calculatePaycheck(input(pa));
    assert.equal(amountOf(r, 'PA_SIT'), dollars(92.1)); // 3,000 × 3.07%
  });

  // PA is the first state in this project where the EMPLOYEE (not just the
  // employer) pays a UC/SUTA contribution — confirmed from two independent
  // PA Dept. of Labor & Industry pages: 0.07% of gross wages, no wage cap.
  test('employee UC withholding: 0.07% of gross wages, uncapped', () => {
    const r = calculatePaycheck(input(pa));
    assert.equal(amountOf(r, 'PA_UC_EE'), dollars(2.1)); // 3,000 × 0.07%
  });

  test('401(k) deferral does NOT reduce the PA UC base either — same taxable-wages rule as PA_SIT', () => {
    const r = calculatePaycheck(
      input({
        ...pa,
        deductions: [
          { code: '401K', category: 'deferral_401k', amount: dollars(500) },
        ],
      }),
    );
    assert.equal(amountOf(r, 'PA_UC_EE'), dollars(2.1)); // still 3,000 × 0.07%
  });

  test('Section 125 reduces the PA base', () => {
    const r = calculatePaycheck(
      input({
        ...pa,
        deductions: [
          { code: 'MED', category: 'section125', amount: dollars(100) },
        ],
      }),
    );
    assert.equal(amountOf(r, 'PA_SIT'), dollars(89.03)); // 2,900 × 3.07%
  });

  test('401(k) deferral does NOT reduce the PA base, unlike federal', () => {
    const r = calculatePaycheck(
      input({
        ...pa,
        deductions: [
          { code: '401K', category: 'deferral_401k', amount: dollars(500) },
        ],
      }),
    );
    // PA still taxes the full 3,000 — this is the rule a single shared
    // "taxable wages" figure would silently get wrong.
    assert.equal(amountOf(r, 'PA_SIT'), dollars(92.1));
  });

  test('three different taxable bases on one cheque', () => {
    const r = calculatePaycheck(
      input({
        ...pa,
        deductions: [
          { code: 'MED', category: 'section125', amount: dollars(100) },
          { code: '401K', category: 'deferral_401k', amount: dollars(200) },
        ],
      }),
    );
    const baseOf = (id: string) => r.taxes.find((t) => t.id === id)!.taxableWages;
    assert.equal(baseOf('US_FIT'), dollars(2700)); // both excluded
    assert.equal(baseOf('US_SS_EE'), dollars(2900)); // deferral taxed
    assert.equal(baseOf('PA_SIT'), dollars(2900)); // deferral taxed
  });

  test('an unmodelled state is flagged, never silently zero', () => {
    // Was CA, then TX, then HI, then WY, before this project built those
    // states — WY was the last of the 51 real jurisdictions to get a
    // data/states/*.json file, so there is no longer any REAL state code
    // this test can borrow. 'ZZ' is not a real two-letter US state/territory
    // code and never will be — using it (rather than a future tax year for
    // a real state, which would hit the FEDERAL ruleset lookup first and
    // throw for the wrong reason) keeps this test exercising exactly the
    // no-ruleset-file flag it means to, permanently, with no future state
    // build ever able to make it stale again.
    const r = calculatePaycheck(input({ workState: { code: 'ZZ' } }));
    const line = r.taxes.find((t) => t.id === 'ZZ_SIT');
    assert.ok(line);
    assert.match(line.detail ?? '', /NOT MODELLED/);
  });

  test("reciprocity SWAP (REV-419): a New Jersey resident working in PA gets $0 PA tax AND a real NJ tax line instead", () => {
    // Biweekly $3,000, no certificate on either side — the SAME default
    // fixture NJ's own 'Rate A, 0 exemptions' test already proved computes
    // to $120.74 when NJ is the WORK state. Here PA is the work state and
    // NJ is only the RESIDENCE state, so this proves the swap mechanism
    // reproduces that exact figure via the virtual-input path, not a
    // coincidence — reciprocitySwapWithholdingLine() runs incomeTaxLines()
    // against NJ's own ruleset on the same wages.
    const r = calculatePaycheck(
      input({
        workState: { code: 'PA' },
        residenceState: { code: 'NJ' },
      }),
    );
    assert.equal(amountOf(r, 'PA_SIT'), 0);
    assert.equal(amountOf(r, 'NJ_SIT_RECIPROCITY_SWAP'), dollars(120.74));
  });

  test('reciprocity SWAP does not over-apply: a New York resident working in PA owes full PA tax and gets no swap line at all', () => {
    const r = calculatePaycheck(
      input({
        workState: { code: 'PA' },
        residenceState: { code: 'NY' },
      }),
    );
    assert.equal(amountOf(r, 'PA_SIT'), dollars(92.1)); // full 3.07%, no exemption — NY isn't reciprocal
    assert.equal(r.taxes.some((t) => t.id === 'NY_SIT_RECIPROCITY_SWAP'), false);
  });

  // Act 32 local EIT + LST, wired to calc-code this pass — reads the real
  // 2,627-jurisdiction data/local/PA-EIT-LST-2026.json registry. Fixtures
  // use Pittsburgh's own two real PSD codes (700102 = Pittsburgh City /
  // Pittsburgh SD, totalResidentEIT 3.0%, nonresidentEIT 1.0%; 730105 =
  // Pittsburgh City / Baldwin-Whitehall SD, totalResidentEIT 1.5%) rather
  // than invented numbers, so these tests double as a sanity check on the
  // underlying data file too.
  test('EIT withholds at the RESIDENT rate when it is higher: lives and works at PSD 700102 (3.0% vs 1.0% nonresident)', () => {
    const r = calculatePaycheck(
      input({
        workState: { code: 'PA', certificate: { workPSD: '700102', residencePSD: '700102' } },
      }),
    );
    assert.equal(amountOf(r, 'PA_EIT'), dollars(90.0)); // 3,000 × 3.0%
  });

  test('EIT withholds at the NONRESIDENT rate when it is higher: out-of-state resident working at PSD 700102', () => {
    const r = calculatePaycheck(
      input({
        workState: { code: 'PA', certificate: { workPSD: '700102' } }, // no residencePSD = out-of-state
      }),
    );
    assert.equal(amountOf(r, 'PA_EIT'), dollars(30.0)); // 3,000 × 1.0% nonresident (0% resident, out-of-state)
  });

  test('EIT compares TWO DIFFERENT PSDs correctly: resident of 730105 (1.5%) working at 700102 (1.0% nonresident)', () => {
    const r = calculatePaycheck(
      input({
        workState: { code: 'PA', certificate: { workPSD: '700102', residencePSD: '730105' } },
      }),
    );
    assert.equal(amountOf(r, 'PA_EIT'), dollars(45.0)); // 3,000 × 1.5% resident (higher than 1.0% nonresident)
  });

  // Philadelphia (PSD 510101) FIXED 2026-09-04: this file's own snapshot of
  // PA DCED's bulk register still carried FY2026's expired rate (3.74%),
  // because Philadelphia collects its own Wage Tax directly, outside the
  // Act 32/DCED system, on its own July 1 fiscal-year boundary. Corrected
  // against phila.gov directly to FY2027's 3.735% resident rate.
  // The rate resets every 1 July, so it is dated: FY2026's 3.74% until
  // 2026-06-30, FY2027's 3.735% from 2026-07-01.
  test("Philadelphia's Wage Tax uses the fiscal year of the check date (3.74% before 1 July 2026, 3.735% after)", () => {
    const phl = (checkDate: string) =>
      calculatePaycheck(
        input({
          checkDate,
          workState: { code: 'PA', certificate: { workPSD: '510101', residencePSD: '510101' } },
        }),
      );
    assert.equal(amountOf(phl('2026-06-12'), 'PA_EIT'), dollars(112.2)); // 3,000 × 3.74%
    assert.equal(amountOf(phl('2026-07-10'), 'PA_EIT'), dollars(112.05)); // 3,000 × 3.735%
  });

  // EIT low-income exemption (BUG FIXED 2026-09-02): PSD 100401 (Adams
  // Twp) carries a municipal-only $5,000 threshold — residentEIT 0.5%,
  // nonresidentEIT 1.0%, schoolDistrictEIT 0.5% (no schoolDistrictEitLIE
  // on file), so estimated-annual-income below $5,000 exempts only the
  // MUNICIPAL portion, never the school portion (which has no ordinance).
  test('EIT low-income exemption: a nonresident earning below the threshold owes $0 (fully municipal, no school component)', () => {
    const r = calculatePaycheck(
      input({
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(150) }],
        workState: { code: 'PA', certificate: { workPSD: '100401' } }, // out-of-state resident
      }),
    );
    // $150 x 26 = $3,900/yr, below the $5,000 municipal threshold.
    assert.equal(amountOf(r, 'PA_EIT'), 0);
  });

  test('EIT low-income exemption applies PARTIALLY, not all-or-nothing: exempts only the municipal portion, not the school portion', () => {
    const r = calculatePaycheck(
      input({
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(150) }],
        workState: { code: 'PA', certificate: { workPSD: '100401', residencePSD: '100401' } },
      }),
    );
    // Same $3,900/yr, below the $5,000 MUNICIPAL threshold only —
    // schoolDistrictEitLIE isn't on file for this PSD, so the 0.5% school
    // component still applies: $150 x 0.5% = $0.75, not $0 or $1.50.
    assert.equal(amountOf(r, 'PA_EIT'), dollars(0.75));
  });

  test('EIT low-income exemption does not fire above the threshold', () => {
    const r = calculatePaycheck(
      input({
        workState: { code: 'PA', certificate: { workPSD: '100401', residencePSD: '100401' } },
      }),
    );
    // Default $3,000/period x 26 = $78,000/yr, well above $5,000 — full
    // 1.0% combined resident rate applies (higher than 1.0% nonresident).
    assert.equal(amountOf(r, 'PA_EIT'), dollars(30.0));
  });

  test('LST prorates the $52/yr combined total across biweekly periods: $2.00/period', () => {
    const r = calculatePaycheck(
      input({
        workState: { code: 'PA', certificate: { workPSD: '700102', residencePSD: '700102' } },
      }),
    );
    assert.equal(amountOf(r, 'PA_LST'), dollars(2.0)); // 52 / 26 periods = exactly $2.00
  });

  test('LST low-income exemption: biweekly $400 (annualized $10,400) is below the $12,000 threshold', () => {
    const r = calculatePaycheck(
      input({
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        workState: { code: 'PA', certificate: { workPSD: '700102', residencePSD: '700102' } },
      }),
    );
    assert.equal(amountOf(r, 'PA_LST'), 0);
  });

  // LST low-income exemption (BUG FIXED 2026-09-02): the old logic picked
  // ONE threshold (municipal if present, else school's `||` fallback) and
  // exempted the WHOLE combined LST off it — wrong whenever the two
  // portions' own thresholds disagree. These two PSDs are exactly that
  // shape, hand-picked from the real data (not invented).
  test("LST low-income exemption with DIFFERENT municipal/school thresholds: only the portion below ITS OWN threshold is exempted", () => {
    // PSD 650701 (Adamsburg Boro): municipal $47 LST, LIE $12,000;
    // school $5 LST, LIE $3,200. Weekly $200 -> annualized $10,400 is
    // below the municipal threshold but ABOVE the school one — the old
    // `||` logic would have read the municipal $12,000 first and
    // exempted the whole $52. Correct: only the $47 municipal portion is
    // exempted; the $5 school portion is still owed = $5/52 = $0.0961,
    // rounded down to $0.09.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
        workState: { code: 'PA', certificate: { workPSD: '650701', residencePSD: '650701' } },
      }),
    );
    assert.equal(amountOf(r, 'PA_LST'), dollars(0.09));
  });

  test('LST low-income exemption where the MUNICIPAL portion is explicitly never-exempt ($0 threshold): the `||` fallback used to wrongly waive it too', () => {
    // PSD 180105 (Beech Creek Boro): municipal $5 LST, LIE $0 (an
    // explicit "never exempt" sentinel, not an absent field); school $5
    // LST, LIE $12,000. Weekly $150 -> annualized $7,800, below the
    // school threshold. Old code: `lst.lowIncomeExemption.municipal || ...
    // .schoolDistrict` reads 0 as FALSY in JS and falls through to the
    // school's $12,000, wrongly exempting the whole $10 including the
    // never-exempt municipal $5. Correct: only the school's $5 portion is
    // exempted; the municipal $5 is still owed = $5/52 = $0.0961, rounded
    // down to $0.09 — same dollar figure as the test above, different
    // mechanism (a false "fully exempt" from the old code would have
    // produced $0 here, not $0.09).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(150) }],
        workState: { code: 'PA', certificate: { workPSD: '180105', residencePSD: '180105' } },
      }),
    );
    assert.equal(amountOf(r, 'PA_LST'), dollars(0.09));
  });

  // Secondary-employer dedup — closed 2026-09-06. PA DCED's own situs-
  // priority text says a secondary employer need not withhold LST if
  // shown proof the principal employer already did; previously disclosed
  // but not modelled, meaning two concurrent PA employers at the same PSD
  // would have double-charged it.
  test('certificate.lstAlreadyWithheldElsewhere skips LST for a secondary employer at the same PSD', () => {
    const r = calculatePaycheck(
      input({
        workState: {
          code: 'PA',
          certificate: { workPSD: '700102', residencePSD: '700102', lstAlreadyWithheldElsewhere: true },
        },
      }),
    );
    assert.equal(amountOf(r, 'PA_LST'), 0);
  });

  test('lstAlreadyWithheldElsewhere not supplied: LST still withholds normally ($2.00/period)', () => {
    const r = calculatePaycheck(
      input({
        workState: { code: 'PA', certificate: { workPSD: '700102', residencePSD: '700102' } },
      }),
    );
    assert.equal(amountOf(r, 'PA_LST'), dollars(2.0));
  });

  test('missing certificate.workPSD is flagged NOT MODELLED, never silently zero', () => {
    const r = calculatePaycheck(input({ workState: { code: 'PA' } }));
    const line = r.taxes.find((t) => t.id === 'PA_EIT');
    assert.ok(line);
    assert.equal(line.amount, 0);
    assert.match(line.detail ?? '', /NOT MODELLED/);
  });

  test('an unrecognised PSD code is flagged NOT MODELLED, never silently zero', () => {
    const r = calculatePaycheck(
      input({ workState: { code: 'PA', certificate: { workPSD: '999999' } } }),
    );
    const line = r.taxes.find((t) => t.id === 'PA_EIT');
    assert.ok(line);
    assert.equal(line.amount, 0);
    assert.match(line.detail ?? '', /NOT MODELLED/);
  });
});

describe('Michigan', () => {
  // Expected values hand-derived from Form 446 (Rev. 02-26): annualize, less
  // (personal exemption amount x exemptions claimed), x 4.25%, de-annualize.
  // Independently computed before running the engine, same discipline as PA.
  const mi = (allowances = 1) => ({
    workState: { code: 'MI', certificate: { allowances } },
  });

  test('single, biweekly, $3,000, 1 exemption', () => {
    // annual 78,000 − 5,900 = 72,100 × 4.25% = 3,064.25/yr ÷ 26 = 117.86
    const r = calculatePaycheck(input(mi(1)));
    assert.equal(amountOf(r, 'MI_SIT'), dollars(117.86));
  });

  test('zero exemptions claimed withholds more', () => {
    // annual 78,000 × 4.25% = 3,315.00/yr ÷ 26 = 127.50, no allowance subtracted
    const r = calculatePaycheck(input(mi(0)));
    assert.equal(amountOf(r, 'MI_SIT'), dollars(127.5));
  });

  test('401(k) deferral REDUCES the Michigan base — opposite of Pennsylvania', () => {
    // MCL 206.30(l) ties MI tax to federal AGI, so the deferral drops the base
    // to 2,500: annual 65,000 − 5,900 = 59,100 × 4.25% = 2,511.75 ÷ 26 = 96.61
    const r = calculatePaycheck(
      input({
        ...mi(1),
        deductions: [
          { code: '401K', category: 'deferral_401k', amount: dollars(500) },
        ],
      }),
    );
    assert.equal(amountOf(r, 'MI_SIT'), dollars(96.61));

    // The same deduction on the same wages does NOT move the PA number —
    // proves the per-tax taxable-wage architecture holds across two states,
    // not just within one.
    const pa = calculatePaycheck(
      input({
        workState: { code: 'PA' },
        deductions: [
          { code: '401K', category: 'deferral_401k', amount: dollars(500) },
        ],
      }),
    );
    assert.equal(amountOf(pa, 'PA_SIT'), dollars(92.1));
  });

  test('Section 125 also reduces the Michigan base', () => {
    // annual 75,400 − 5,900 = 69,500 × 4.25% = 2,953.75 ÷ 26 = 113.61
    const r = calculatePaycheck(
      input({
        ...mi(1),
        deductions: [
          { code: 'MED', category: 'section125', amount: dollars(100) },
        ],
      }),
    );
    assert.equal(amountOf(r, 'MI_SIT'), dollars(113.61));
  });

  test('certificate.exempt and certificate.additionalWithholding are GENERIC — proven here via flatRate(), not just Minnesota\'s bracket method', () => {
    // Same base case as 'single, biweekly, $3,000, 1 exemption' ($117.86).
    // state.ts's applyStateWithholdingExemption()/applyAdditionalStateWithholding()
    // wrap EVERY income-tax method's output (matched by the shared
    // `${code}_SIT` id prefix, not hardcoded to bracket_flat_allowance), so
    // Michigan's flat_rate method gets both for free.
    const exempt = calculatePaycheck(input({ ...mi(1), workState: { code: 'MI', certificate: { allowances: 1, exempt: true } } }));
    assert.equal(amountOf(exempt, 'MI_SIT'), 0);

    const withExtra = calculatePaycheck(
      input({ workState: { code: 'MI', certificate: { allowances: 1, additionalWithholding: dollars(15) } } }),
    );
    assert.equal(amountOf(withExtra, 'MI_SIT'), dollars(117.86 + 15));
  });

  test('reciprocity is also generic — an Ohio resident working in Michigan owes $0 MI income tax', () => {
    // Ohio is one of MI's reciprocalStates (data/states/MI-2026.json).
    const r = calculatePaycheck(
      input({ residenceState: { code: 'OH' }, ...mi(1) }),
    );
    assert.equal(amountOf(r, 'MI_SIT'), 0);
  });

  test('supplemental (bonus) wages withhold a flat 4.25%, with no exemption adjustment, WITHOUT being taxed twice', () => {
    // A real double-taxation bug lived here until a later "go to every
    // state" pass: flatRate() computed MI_SIT over a base that still
    // INCLUDED the bonus, so the $1,000 supplemental payment was taxed
    // once via MI_SIT's regular flat rate AND again via MI_SIT_SUPP —
    // asserting both lines here so that regression can't go silent again.
    // MI_SIT must see only the $3,000 regular wage — same $117.86 as the
    // no-bonus baseline test above, proving the bonus was correctly
    // carved out, not just coincidentally close.
    const r = calculatePaycheck(
      input({
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(3000) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
        ],
        ...mi(1),
      }),
    );
    assert.equal(amountOf(r, 'MI_SIT'), dollars(117.86));
    assert.equal(amountOf(r, 'MI_SIT_SUPP'), dollars(42.5)); // 1,000 × 4.25%
  });

  describe('local city income tax', () => {
    test('resident of a taxing city owes that city\'s resident rate on all earnings', () => {
      // Albion: 1% resident, $600 exemption. Annual 78,000 − 600 = 77,400
      // × 1% = 774.00/yr ÷ 26 = $29.77.
      const r = calculatePaycheck(
        input({
          workState: {
            code: 'MI',
            certificate: { allowances: 1, residenceCity: 'Albion' },
          },
        }),
      );
      assert.equal(amountOf(r, 'MI_LOCAL'), dollars(29.77));
    });

    test('nonresident working in a taxing city owes that city\'s lower nonresident rate', () => {
      // Battle Creek: 0.5% nonresident, $750 exemption. Annual 78,000 − 750
      // = 77,250 × 0.5% = 386.25/yr ÷ 26 = $14.86.
      const r = calculatePaycheck(
        input({
          workState: {
            code: 'MI',
            certificate: { allowances: 1, workCity: 'Battle Creek' },
          },
        }),
      );
      assert.equal(amountOf(r, 'MI_LOCAL'), dollars(14.86));
    });

    test('resident of one taxing city working in another owes BOTH lines, no automatic net credit', () => {
      // Albion resident ($29.77, from above) + Battle Creek nonresident
      // ($14.86, from above) = $44.63 combined — the inter-city credit is
      // a return-level mechanism, not applied at withholding time.
      const r = calculatePaycheck(
        input({
          workState: {
            code: 'MI',
            certificate: { allowances: 1, residenceCity: 'Albion', workCity: 'Battle Creek' },
          },
        }),
      );
      assert.equal(amountOf(r, 'MI_LOCAL'), dollars(44.63));
    });

    test('living and working in the SAME taxing city fires the tax only once, at the resident rate', () => {
      const r = calculatePaycheck(
        input({
          workState: {
            code: 'MI',
            certificate: { allowances: 1, residenceCity: 'Albion', workCity: 'Albion' },
          },
        }),
      );
      assert.equal(amountOf(r, 'MI_LOCAL'), dollars(29.77));
    });

    test('neither city is one of the 24 taxing cities — $0, not silently omitted', () => {
      const r = calculatePaycheck(
        input({
          workState: {
            code: 'MI',
            certificate: { allowances: 1, residenceCity: 'Ann Arbor' },
          },
        }),
      );
      assert.equal(amountOf(r, 'MI_LOCAL'), 0);
    });

    test('no city fields at all produces no MI_LOCAL line — most employees never touch this', () => {
      const r = calculatePaycheck(input(mi(1)));
      const line = r.taxes.find((t) => t.id === 'MI_LOCAL');
      assert.equal(line, undefined);
    });
  });
});

describe('Indiana', () => {
  // Expected values hand-derived from Departmental Notice #1 (R46 / 01-26)
  // before the code was run, same discipline as PA/MI. Indiana is the first
  // state modelled here with a MANDATORY county add-on sharing the state's
  // own reduced base, and a four-tier exemption schedule instead of one.
  const inState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'IN', certificate },
  });

  test('Boone County steps from 1.70% to 1.71% on 2026-10-01 (R47 / 10-26); no other county moves', () => {
    // Departmental Notice #1 R47 / 10-26 marks Boone (06) 0.0171* and no other
    // county. $1,000 weekly, one exemption: taxable = 1,000 - 19.23 = 980.77.
    // County: 980.77 x 1.70% = 16.67 before; 980.77 x 1.71% = 16.77 from Oct 1.
    const county = (checkDate: string, name: string) =>
      amountOf(
        calculatePaycheck(
          input({
            checkDate,
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            ...inState({ county: name, personalExemptions: 1 }),
          }),
        ),
        'IN_COUNTY',
      );
    assert.equal(county('2026-09-30', 'Boone'), dollars(16.67));
    assert.equal(county('2026-10-01', 'Boone'), dollars(16.77));
    assert.equal(county('2026-10-01', 'Hendricks'), county('2026-09-30', 'Hendricks'));
  });

  test("reproduces Departmental Notice #1's own worked example to the cent", () => {
    // Weekly $800; 5 personal + 3 dependent + 1 first-time-dependent + 2
    // adopted-child exemptions. Each tier's per-period constant, rounded
    // independently: 1,000×5/52=96.15, 1,500×3/52=86.54, 1,500×1/52=28.85,
    // 3,000×2/52=115.38 → total deduction constant $326.92 (matches the
    // notice's own total). Taxable = 800.00 − 326.92 = 473.08 (matches).
    // Harrison County is a real 1% county — the notice's own example rate.
    // State: 473.08 × 2.95% = 13.96. County: 473.08 × 1% = 4.73. Both match
    // Departmental Notice #1's own worked answer exactly.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
        ...inState({
          county: 'Harrison',
          personalExemptions: 5,
          dependentExemptions: 3,
          firstTimeDependentExemptions: 1,
          adoptedChildExemptions: 2,
        }),
      }),
    );
    assert.equal(amountOf(r, 'IN_SIT'), dollars(13.96));
    assert.equal(amountOf(r, 'IN_COUNTY'), dollars(4.73));
    const baseOf = (id: string) => r.taxes.find((t) => t.id === id)!.taxableWages;
    assert.equal(baseOf('IN_SIT'), dollars(473.08));
    assert.equal(baseOf('IN_COUNTY'), dollars(473.08)); // same shared base
  });

  test('zero exemptions taxes the full wage; state and county share one base', () => {
    // Weekly $800, no exemptions, Marion County (2.02%).
    // State: 800 × 2.95% = 23.60. County: 800 × 2.02% = 16.16.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
        ...inState({ county: 'Marion' }),
      }),
    );
    assert.equal(amountOf(r, 'IN_SIT'), dollars(23.6));
    assert.equal(amountOf(r, 'IN_COUNTY'), dollars(16.16));
  });

  test('reciprocity exempts STATE tax only — county tax still applies (WH-47\'s own critical gotcha)', () => {
    // Same $800/wk, Marion County case as above, but residenceState:KY —
    // one of Indiana's reciprocalStates. Per data/states/IN-2026.json's own
    // reciprocity.rule ('this exemption does NOT extend to Indiana COUNTY
    // tax'), IN_SIT must drop to $0 while IN_COUNTY stays at $16.16,
    // completely unaffected. This is the case a naive whole-line-array
    // reciprocity implementation would get wrong — state.ts's
    // zeroStateIncomeTaxLines() only zeroes IN_SIT-prefixed lines.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
        residenceState: { code: 'KY' },
        ...inState({ county: 'Marion' }),
      }),
    );
    assert.equal(amountOf(r, 'IN_SIT'), 0);
    assert.equal(amountOf(r, 'IN_COUNTY'), dollars(16.16));
  });

  test('reciprocity is generic across states too — a Pennsylvania resident working in Indiana gets the same state/county split as Kentucky above', () => {
    // Same fixture as the KY test immediately above, residenceState swapped
    // to PA — proving WH-47's state-only exemption isn't accidentally
    // KY-specific plumbing. IN-2026.json's reciprocalStates lists PA with
    // no per-state carve-out (unlike Virginia's daily-commute condition on
    // Kentucky's own reciprocalStates), so this is expected to match KY's
    // result exactly, and does.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
        residenceState: { code: 'PA' },
        ...inState({ county: 'Marion' }),
      }),
    );
    assert.equal(amountOf(r, 'IN_SIT'), 0);
    assert.equal(amountOf(r, 'IN_COUNTY'), dollars(16.16));
  });

  test('401(k) deferral reduces BOTH the state and county base — federal-AGI conformity', () => {
    // Biweekly $3,000, 1 personal exemption, Allen County (1.59%), $500 401(k).
    // Deduction constant: 1,000/26 = 38.46. Taxable = 3,000 − 500 − 38.46 = 2,461.54.
    // State: 2,461.54 × 2.95% = 72.615… → 72.62. County: 2,461.54 × 1.59% = 39.138… → 39.14.
    const r = calculatePaycheck(
      input({
        deductions: [
          { code: '401K', category: 'deferral_401k', amount: dollars(500) },
        ],
        ...inState({ county: 'Allen', personalExemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'IN_SIT'), dollars(72.62));
    assert.equal(amountOf(r, 'IN_COUNTY'), dollars(39.14));
  });

  test('a missing county is flagged, never silently zero', () => {
    // Biweekly $3,000, 1 personal exemption, no county on the certificate.
    // Deduction constant 1,000/26 = 38.46 → taxable 2,961.54 × 2.95% = 87.37.
    const r = calculatePaycheck(input(inState({ personalExemptions: 1 })));
    assert.equal(amountOf(r, 'IN_SIT'), dollars(87.37)); // state unaffected
    const county = r.taxes.find((t) => t.id === 'IN_COUNTY');
    assert.ok(county);
    assert.equal(county.amount, 0);
    assert.match(county.detail ?? '', /NOT MODELLED/);
  });

  test('an unrecognised county name is flagged, never silently zero', () => {
    const r = calculatePaycheck(
      input(inState({ county: 'Not A Real County', personalExemptions: 1 })),
    );
    assert.equal(amountOf(r, 'IN_SIT'), dollars(87.37)); // state still computes
    const county = r.taxes.find((t) => t.id === 'IN_COUNTY');
    assert.ok(county);
    assert.equal(county.amount, 0);
    assert.match(county.detail ?? '', /NOT MODELLED/);
  });
});

describe('Illinois', () => {
  // Expected values hand-derived from the 2026 IL-700-T formula and the
  // Illinois Comptroller's 2026 payroll bulletin before the code was run,
  // same discipline as PA/MI/Indiana. Illinois has TWO exemption tiers (like
  // Indiana) but NO local income tax at all (unlike Indiana) — the state
  // line should be the ONLY line these fixtures ever produce.
  const ilState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'IL', certificate },
  });

  test('one basic allowance reproduces the Comptroller-confirmed bi-weekly exemption exactly', () => {
    // Biweekly $3,000, 1 basic allowance, 0 additional.
    // Deduction: 2,925/26 = 112.50 (matches the Comptroller's 2026 bulletin's
    // own stated bi-weekly exemption figure exactly — an independent check
    // on the per-period rounding, not just the formula).
    // Taxable: 3,000 - 112.50 = 2,887.50. Tax: 2,887.50 x 4.95% = 142.93 (rounds down from .125).
    const r = calculatePaycheck(input(ilState({ basicAllowances: 1 })));
    assert.equal(amountOf(r, 'IL_SIT'), dollars(142.93));
    const baseOf = (id: string) => r.taxes.find((t) => t.id === id)!.taxableWages;
    assert.equal(baseOf('IL_SIT'), dollars(2887.5));
  });

  test('zero allowances taxes the full wage', () => {
    // Weekly $800, no allowances. 800 x 4.95% = 39.60 exactly.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
        ...ilState({}),
      }),
    );
    assert.equal(amountOf(r, 'IL_SIT'), dollars(39.6));
  });

  test('reciprocity: a Wisconsin resident working in Illinois owes $0 IL income tax', () => {
    // Same $800/wk, zero-allowance case as above. Wisconsin is one of
    // Illinois's reciprocalStates (data/states/IL-2026.json) — and unlike
    // Indiana, Illinois has no local tax for the exemption to carve around,
    // so this should be a clean $0, full stop.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
        residenceState: { code: 'WI' },
        ...ilState({}),
      }),
    );
    assert.equal(amountOf(r, 'IL_SIT'), 0);
  });

  test('401(k) deferral reduces the Illinois base — federal-AGI conformity', () => {
    // Biweekly $3,000, 2 basic + 1 additional allowance, $500 401(k).
    // Deduction constant: 2,925x2/26 = 225.00, plus 1,000x1/26 = 38.46
    // (rounds down from 38.4615...) = 263.46 total.
    // Taxable: 3,000 - 500 - 263.46 = 2,236.54. Tax: 2,236.54 x 4.95% = 110.71 (rounds up from .873).
    const r = calculatePaycheck(
      input({
        deductions: [
          { code: '401K', category: 'deferral_401k', amount: dollars(500) },
        ],
        ...ilState({ basicAllowances: 2, additionalAllowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'IL_SIT'), dollars(110.71));
  });

  test("IL-700-T's own worked example, recomputed — pins a known stale-example discrepancy", () => {
    // Weekly $300, 2 basic + 1 additional allowance — the exact inputs of
    // the IL-700-T page's own "Mary" narrative example, which states the
    // answer as $8.38. Recomputing from that SAME page's own formula and the
    // Comptroller-confirmed $2,925/$1,000 exemption amounts gives $8.33, not
    // $8.38 — see data/states/IL-2026.json's knownGaps for the full
    // disclosure. This fixture pins the formula-correct answer rather than
    // silently matching stale prose.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(300) }],
        ...ilState({ basicAllowances: 2, additionalAllowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'IL_SIT'), dollars(8.33));
  });

  test('no local tax line is ever produced — Illinois genuinely has none', () => {
    const r = calculatePaycheck(input(ilState({ basicAllowances: 1 })));
    assert.equal(
      r.taxes.some((t) => t.jurisdiction === 'local'),
      false,
    );
  });
});

describe('Wisconsin', () => {
  // Expected values hand-derived from Publication W-166's own "Alternate
  // Method of Withholding" formula and worked examples, same discipline as
  // every other state. Wisconsin is the first state in this project with a
  // genuine progressive bracket schedule PLUS an income-phased-out standard
  // deduction (not a flat allowance) — three of these five fixtures reproduce
  // W-166's own published examples to the cent, not values computed only by
  // this engine.
  const wiState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'WI', certificate },
  });

  test("Publication W-166 Example 1: single, weekly $350, 1 exemption", () => {
    // Annual 350x52=18,200. Deduction: 6,702 - 12%x(18,200-17,780) = 6,702 -
    // 50.40 = 6,651.60. Less: 18,200 - 6,651.60 = 11,548.40. Less 1 exemption
    // ($400): 11,148.40 net. Bracket 1 (0-12,760 @ 3.54%): 11,148.40 x
    // 3.54% = 394.65. ÷52 = 7.59 (W-166's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(350) }],
        ...wiState({ maritalStatus: 'single', exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'WI_SIT'), dollars(7.59));
  });

  test("Publication W-166 Example 2: single, weekly $500, 3 exemptions", () => {
    // Annual 500x52=26,000. Deduction: 6,702 - 12%x(26,000-17,780) = 6,702 -
    // 986.40 = 5,715.60. Less: 26,000 - 5,715.60 = 20,284.40. Less 3
    // exemptions ($1,200): 19,084.40 net. Bracket 2 (12,760-25,520 @ 4.65%,
    // base 451.70): 451.70 + 4.65%x6,324.40 = 451.70 + 294.08 = 745.78.
    // ÷52 = 14.34 (W-166's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        ...wiState({ maritalStatus: 'single', exemptions: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'WI_SIT'), dollars(14.34));
  });

  test("Publication W-166 Example 3: married, biweekly $1,000, 3 exemptions", () => {
    // Annual 1,000x26=26,000. Deduction (married): 9,461 - 20%x(26,000-
    // 25,727) = 9,461 - 54.60 = 9,406.40. Less: 26,000 - 9,406.40 =
    // 16,593.60. Less 3 exemptions ($1,200): 15,393.60 net. Bracket 2: 451.70
    // + 4.65%x2,633.60 = 451.70 + 122.46 = 574.16. ÷26 = 22.08 (W-166's own
    // stated answer). Proves the SAME bracket schedule applies regardless of
    // marital status — only the deduction phase-out differs.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...wiState({ maritalStatus: 'married', exemptions: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'WI_SIT'), dollars(22.08));
  });

  test('low income keeps the FULL standard deduction (below the phase-out start)', () => {
    // Weekly $200, single, 0 exemptions. Annual 200x52=10,400 — below
    // single's $17,780 phase-out start, so the deduction stays at the full
    // $6,702. Net: 10,400 - 6,702 = 3,698. Bracket 1: 3,698 x 3.54% = 130.91.
    // ÷52 = 2.52.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
        ...wiState({ maritalStatus: 'single', exemptions: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'WI_SIT'), dollars(2.52));
  });

  test('high income phases the standard deduction all the way to $0', () => {
    // Weekly $1,500, single, 0 exemptions. Annual 1,500x52=78,000 — above
    // single's $73,630 phase-out end, so the deduction is $0. Net wage equals
    // annual wages: 78,000. Bracket 3 (25,520-280,950 @ 5.30%, base
    // 1,045.04): 1,045.04 + 5.30%x52,480 = 1,045.04 + 2,781.44 = 3,826.48.
    // ÷52 = 73.59.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1500) }],
        ...wiState({ maritalStatus: 'single', exemptions: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'WI_SIT'), dollars(73.59));
  });

  test('supplemental (bonus) wages use a flat bracket-dependent rate, separate from regular wages', () => {
    // Biweekly $500 regular + $1,000 bonus, single, 0 exemptions.
    // Regular line excludes the bonus from its own base: annual 500x26=13,000
    // — below single's $17,780 phase-out start, so the FULL $6,702 deduction
    // applies. Net: 13,000 - 6,702 = 6,298. Bracket 1 (0-12,760 @ 3.54%):
    // 6,298 x 3.54% = 222.95. ÷26 = 8.58.
    // Supplemental line: estimated annual GROSS salary uses the REGULAR wages
    // only (500x26=13,000), which falls in the SECOND bracket (12,760-25,520
    // @ 4.65%) — a genuinely different bracket than the regular line landed
    // in after its own deduction, because this lookup uses gross, not net.
    // The bonus is taxed flatly at that bracket's rate: 1,000 x 4.65% = 46.50.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(500) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
        ],
        ...wiState({ maritalStatus: 'single', exemptions: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'WI_SIT'), dollars(8.58));
    assert.equal(amountOf(r, 'WI_SIT_SUPP'), dollars(46.5));
  });

  test('no supplemental line at all when there is no supplemental income', () => {
    const r = calculatePaycheck(input(wiState({ maritalStatus: 'single', exemptions: 1 })));
    assert.equal(r.taxes.some((t) => t.id === 'WI_SIT_SUPP'), false);
  });

  test('BUG FIX: a pretax deduction exceeding regular wages spills onto the supplemental base too', () => {
    // $500 regular, $800 401(k) deferral (exceeds regular by $300), $1,000
    // bonus. Combined taxable = 500+1,000-800 = $700. Before this fix, the
    // bonus was taxed on the raw, un-reduced $1,000 instead of $700.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(500) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
        ],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(800) }],
        ...wiState({ maritalStatus: 'single', exemptions: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'WI_SIT'), 0);
    assert.equal(amountOf(r, 'WI_SIT_SUPP'), dollars(24.78)); // 700 × 3.54%, not 1,000 × 3.54%
  });

  test('an unrecognized maritalStatus throws rather than silently falling through to single', () => {
    assert.throws(
      () => calculatePaycheck(input(wiState({ maritalStatus: 'divorced', exemptions: 0 }))),
      /Unrecognized WI certificate\.maritalStatus/,
    );
  });
});

describe('Kentucky', () => {
  // Expected values hand-derived from the DOR's own 2026 Withholding Tax
  // Formula (42A003 TCF) before the code was run, same discipline as
  // PA/MI/IN/IL/WI. Kentucky has NO exemption-count concept at all (Form K-4
  // has no personal/dependent count field) — the $3,360 standard deduction
  // is a single flat annual amount, unconditional, which is why Kentucky got
  // its own flatRateFixedDeduction() method instead of reusing flatRate().
  const kyState = () => ({ workState: { code: 'KY' } });

  test("reproduces the DOR's own monthly worked example to the cent", () => {
    // Monthly $3,270: annual 3,270×12=39,240 − 3,360 deduction = 35,880
    // taxable × 3.5% = 1,255.80/yr ÷ 12 = 104.65. Matches 42A003 TCF exactly,
    // including its intermediate figures — no correction needed for this one.
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3270) }],
        ...kyState(),
      }),
    );
    assert.equal(amountOf(r, 'KY_SIT'), dollars(104.65));
  });

  test('certificate.exempt and certificate.additionalWithholding work generically via flatRateFixedDeduction() too', () => {
    // Same $3,270/month base case as above ($104.65).
    const exempt = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3270) }],
        workState: { code: 'KY', certificate: { exempt: true } },
      }),
    );
    assert.equal(amountOf(exempt, 'KY_SIT'), 0);

    const withExtra = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3270) }],
        workState: { code: 'KY', certificate: { additionalWithholding: dollars(20) } },
      }),
    );
    assert.equal(amountOf(withExtra, 'KY_SIT'), dollars(104.65 + 20));
  });

  test('reciprocity: a resident of a KY-reciprocal state owes $0 KY income tax', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3270) }],
        residenceState: { code: 'OH' },
        ...kyState(),
      }),
    );
    assert.equal(amountOf(r, 'KY_SIT'), 0);
  });

  test("reproduces the DOR's own biweekly example, CORRECTED for its own arithmetic error", () => {
    // Biweekly $1,500: annual 1,500×26=39,000 − 3,360 = 35,640 taxable ×
    // 3.5% = 1,247.40/yr ÷ 26 = 47.9769... → 47.98.
    // The source document's own step 3 multiplies a typo'd $35,730 instead
    // of the $35,640 its own step 2 just computed (off by $90), AND its
    // final answer is truncated to a flat "$47" instead of $47.98. Both are
    // flaws in the PRIMARY SOURCE'S own printed example, not in this
    // formula: reproducing the source's typo would require deliberately
    // reimplementing its arithmetic error, so this fixture asserts the
    // value the formula, and the source's own uncorrected step 2, actually
    // imply — $47.98, not $47.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1500) }],
        ...kyState(),
      }),
    );
    assert.equal(amountOf(r, 'KY_SIT'), dollars(47.98));
  });

  test('wages entirely below the standard deduction withhold zero, not negative', () => {
    // Weekly $50: annual 50×52=2,600, below the $3,360 deduction entirely —
    // atLeastZero() clamps the taxable base to 0 before the rate is applied.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(50) }],
        ...kyState(),
      }),
    );
    assert.equal(amountOf(r, 'KY_SIT'), 0);
  });

  test('supplemental wages on the SAME cheque are AGGREGATED, not taxed on a separate line — 103 KAR 18:070', () => {
    // Biweekly $1,500 regular + $500 supplemental in ONE cheque. 103 KAR
    // 18:070 Section 3(1) requires treating same-cheque supplemental wages
    // "as if the aggregate of the supplemental and regular wages were a
    // single wage payment" — the opposite of Wisconsin's bracketSupplementalTax()
    // pattern, which carves supplemental OUT into its own flat-rate line.
    // Combined base 2,000/period: annual 2,000×26=52,000 − 3,360 = 48,640
    // taxable × 3.5% = 1,702.40/yr ÷ 26 = 65.4769... → 65.48.
    // Asserts there is exactly ONE Kentucky state-tax line (no KY_SIT_SUPP),
    // and that its taxableWages figure is the FULL combined base — proof
    // this is genuine aggregation, not a coincidentally-matching total.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(1500) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(500) },
        ],
        ...kyState(),
      }),
    );
    assert.equal(amountOf(r, 'KY_SIT'), dollars(65.48));
    assert.equal(r.taxes.some((t) => t.id === 'KY_SIT_SUPP'), false);
    const line = r.taxes.find((t) => t.id === 'KY_SIT');
    assert.equal(line?.taxableWages, dollars(2000));
  });

  test('401(k) deferral reduces the Kentucky base — federal-AGI conformity, confirmed by a full read of KRS 141.019', () => {
    // Monthly $3,270 with a $270 401(k) deferral: taxable wages drop to
    // 3,000/mo. Annual 36,000 − 3,360 = 32,640 × 3.5% = 1,142.40/yr ÷ 12 = 95.20.
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3270) }],
        deductions: [
          { code: '401K', category: 'deferral_401k', amount: dollars(270) },
        ],
        ...kyState(),
      }),
    );
    assert.equal(amountOf(r, 'KY_SIT'), dollars(95.2));
  });

  test('reciprocity BUG FIX: a Virginia resident who does NOT commute daily owes full KY tax, not $0', () => {
    // Found on an audit pass: 103 KAR 17:140 exempts Virginia residents
    // from Kentucky withholding ONLY if they commute daily — a narrower
    // condition than the other 6 reciprocal states, which are unconditional
    // on residence alone. The engine previously had no way to represent
    // this and granted every one of the 7 states the same blanket
    // exemption. Monthly $3,270, no certificate: reproduces the DOR's own
    // worked example ($104.65) — proof the VA residence, on its own,
    // changes NOTHING when certificate.dailyCommuter isn't set.
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3270) }],
        workState: { code: 'KY' },
        residenceState: { code: 'VA' },
      }),
    );
    assert.equal(amountOf(r, 'KY_SIT'), dollars(104.65));
  });

  test('a Virginia resident who DOES commute daily gets the reciprocity exemption', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3270) }],
        workState: { code: 'KY' },
        residenceState: { code: 'VA', certificate: { dailyCommuter: true } },
      }),
    );
    assert.equal(amountOf(r, 'KY_SIT'), 0);
  });

  test('the other 6 reciprocal states remain UNCONDITIONAL — no dailyCommuter flag needed', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3270) }],
        workState: { code: 'KY' },
        residenceState: { code: 'OH' },
      }),
    );
    assert.equal(amountOf(r, 'KY_SIT'), 0);
  });

  // Local Occupational Tax (KY_LOCAL) — the confirmed-rate subset of
  // data/local/KY-occupational-2026.json's own normalization pass. Rates
  // used below are real: Carlisle 1%, Caldwell County 1.5%, Dayton 2.5%,
  // Louisville Metro 2.2% resident / 1.45% nonresident.
  describe('Local Occupational Tax (KY_LOCAL)', () => {
    // Somerset FIXED 2026-09-04: this entry was still on the pre-increase
    // 0.6% rate, with a note that a reported two-phase increase toward
    // 1.2% hadn't been confirmed enacted. It was — confirmed directly
    // against the City of Somerset's own announcement — phased to 0.9% on
    // 2025-07-01 and to the current 1.2% on 2026-01-01, both now past.
    test("Somerset reflects the current 1.2% rate, not the superseded pre-2025 0.6% one", () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Somerset' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(12.0));
    });

    test('a single city, no county: flat rate on full wages', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Carlisle' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(10.0));
    });

    test('a single county, no city: flat rate on full wages', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCounty: 'Caldwell County' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(15.0));
    });

    test('city + county, county rate HIGHER: KRS 68.197 credit — total equals the county rate, not both stacked', () => {
      // Carlisle (1%) + Caldwell County (1.5%): city pays $10.00 in full;
      // county's $15.00 gross is credited $10.00 for the city fee paid,
      // net county $5.00. Total $15.00 -- the higher of the two, not
      // $10.00 + $15.00 = $25.00 (naive stacking would overtax).
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: {
            code: 'KY',
            certificate: { workCity: 'Carlisle', workCounty: 'Caldwell County' },
          },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(15.0));
    });

    test('city + county, city rate HIGHER: county credit floors at $0, total equals the city rate', () => {
      // Dayton (2.5%) + Caldwell County (1.5%): city pays $25.00 in full;
      // county's $15.00 gross is fully credited away (capped at $15, not
      // refunded), net county $0. Total $25.00.
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: {
            code: 'KY',
            certificate: { workCity: 'Dayton', workCounty: 'Caldwell County' },
          },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(25.0));
    });

    test('KRS 67.750(2): a 401(k) deferral does NOT reduce the local base, unlike every other tax in this engine', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(200) }],
          workState: { code: 'KY', certificate: { workCity: 'Carlisle' } },
        }),
      );
      // Full $1,000 @ 1% = $10.00, NOT ($1,000-$200) @ 1% = $8.00.
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(10.0));
    });

    test('Louisville Metro resident: the resident rate (2.2%), via certificate.residenceCity matching workCity', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: {
            code: 'KY',
            certificate: { workCity: 'Louisville', residenceCity: 'Louisville' },
          },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(22.0));
    });

    test('Louisville Metro nonresident worker: the lower nonresident rate (1.45%)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Louisville' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(14.5));
    });

    // Lexington-Fayette WIRED 2026-09-04: previously a single flat 2.25%
    // (LFUCG only). Fayette County Public Schools levies its own separate
    // 0.5% RESIDENT-ONLY occupational tax, own withholding requirement, not
    // blended into LFUCG's figure — reshaped into a resident/nonresident
    // split (2.75%/2.25%) the same way Louisville's own school-board
    // component already works, reusing kentuckyLocalTax()'s existing
    // resident/nonresident logic with no code change to that function.
    test('Lexington-Fayette resident: LFUCG (2.25%) + the separate FCPS school tax (0.5%) = 2.75%', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: {
            code: 'KY',
            certificate: { workCity: 'Lexington', residenceCity: 'Lexington' },
          },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(27.5));
    });

    test("Lexington-Fayette nonresident worker: LFUCG only (2.25%) — FCPS's tax is resident-only", () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Lexington' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(22.5));
    });

    test('no certificate.workCity/workCounty: no KY_LOCAL line at all', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY' },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'KY_LOCAL'), false);
    });

    test('an unrecognized KY city/county name: no KY_LOCAL line, not a guess', () => {
      // This test's example changed SEVEN times across 2026-08-31: every
      // real scraped entry it was ever pinned to (Bardstown, Hillview,
      // Cadiz, Warsaw, Clarkson, Muldraugh) turned out to have a real,
      // confirmable wage rate once research went far enough -- the KY
      // League of Cities' own statewide survey resolved 249 of 250
      // scraped entries. The one exception, Marshall County Occupational
      // License Tax For Schools, briefly got a false-positive 0.5% wage
      // rate applied this same session (a WebSearch summary and an
      // out-of-context grep fragment both misread its "Payroll Factor"
      // business-apportionment worksheet as a personal wage tax) --
      // reading its full 6-page Form M-W instructions directly showed it
      // is genuinely net-profits-only, filed by sole proprietors and
      // corporations, with no wage-withholding section anywhere in the
      // document. See that entry's own wageRateNote and the dedicated
      // test just below. Switched THIS test to a name that will never
      // resolve, by construction, so it stops needing to be re-pinned
      // every time research gets more thorough.
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Not A Real Kentucky City' } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'KY_LOCAL'), false);
    });

    test('Marshall County Occupational License Tax For Schools: genuinely net-profits-only, confirmed by reading its full Form M-W instructions -- no KY_LOCAL wage line, not a guess', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: {
            code: 'KY',
            certificate: { workCounty: 'Marshall County Occupational License Tax For Schools' },
          },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'KY_LOCAL'), false);
    });

    test('Hillview: real rate is 1.1%, correcting this file\'s own earlier inferred-tier guess of 1.8%', () => {
      // The inferred-tier guess (assuming the scraped Net Profits figure
      // doubled as wages) was wrong here -- KLC's official FY2023
      // statewide survey gives the real Payroll Tax Rate as 1.1%.
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Hillview' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(11.0));
    });

    test('Hardin County Industrial Tax District: newly confirmed at 1% ("gross payroll" figure the parser initially missed)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: {
            code: 'KY',
            certificate: { workCounty: 'Hardin County Industrial Tax District' },
          },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(10.0));
    });

    test('Allen County: promoted by hand from "ambiguous" after its own source field turned out to directly quote the wage figure (1%)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCounty: 'Allen County' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(10.0));
    });

    test('Cadiz: real wage rate is 1.9%, per KLC\'s statewide survey -- corrects an earlier weaker-sourced 1.5% figure, itself already separate from the scraped Gross Receipts 1%', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Cadiz' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(19.0));
    });

    test('Erlanger: real wage rate (1.5%, raised from 1.00%) found separate from its scraped Gross Receipts figure (0.00075%)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Erlanger' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(15.0));
    });

    test('West Buechel: its own 1.5% (city audit document) stacks on Metro\'s 1.45% nonresident rate', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'West Buechel' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(29.5));
    });

    test('Lynnview: no separate ordinance found, so it inherits the countywide Louisville Metro rate -- same pattern as Lyndon/Middletown', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: {
            code: 'KY',
            certificate: { workCity: 'Lynnview', residenceCity: 'Lynnview' },
          },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(22.0));
    });

    test('Auburn: real wage rate (1.5%) confirmed via the city\'s own site, separate from its scraped Gross Receipts figure', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Auburn' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(15.0));
    });

    test('Oak Grove: real wage rate (1.5%) confirmed via the city\'s own site, separate from its scraped tiered business schedule', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Oak Grove' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(15.0));
    });

    test('Elkton: real wage rate (2%) confirmed via the city\'s own site, correcting the scraped .125% Gross Receipts figure', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Elkton' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(20.0));
    });

    test('Cave City: real wage rate (2%) corrects this file\'s own earlier 1% inferred-tier guess, per the city\'s official withholding form', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Cave City' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(20.0));
    });

    test('Eminence: real wage rate (0.75%) corrects a 100x decimal-placement error in the scraped 0.0075% figure', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Eminence' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(7.5));
    });

    test('Clarkson: real wage rate (1.2%) confirmed via cityofclarkson.com, correcting the ambiguous Gross Receipts category', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Clarkson' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(12.0));
    });

    test('Bardstown: confirmed 1% (2026-08-31 pass) against its own municipal code Sec. 117.03', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Bardstown' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(10.0));
    });

    test('Estill County: promoted via KACo\'s own dedicated payroll column (cross-source, not primary)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCounty: 'Estill County' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(20.0));
    });

    test('Bowling Green: a bare "Net Profits" SOS category, independently confirmed as the wage rate by a second source (USDA NFC)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Bowling Green' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(20.0));
    });

    test("Covington: the SOS-vs-NFC discrepancy is now SETTLED by the city's own page — 2.45% on wages, and the 2.5% was the net-profits rate", () => {
      // The previous pass left this unconfirmed rather than choosing
      // between two sources. Covington's own Finance Department page
      // settles it: employers withhold 2.45% on compensation, while 2.5%
      // is the separate net profits tax. So the SOS figure was never the
      // wage rate — the Hopkinsville pattern this file warns about.
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Covington' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(24.5));
    });

    test('Covington caps each employee at the Social Security wage base, like Walton and Florence', () => {
      // $184,500 of the 2026 base is already used, so only $500 of this
      // $1,000 cheque is still taxable: $500 x 2.45% = $12.25.
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Covington' } },
          ytd: {
            socialSecurity: 0,
            medicare: 0,
            futa: 0,
            localIncomeTax: { KY_LOCAL_Covington: dollars(184000) },
          },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(12.25));
    });

    test("Nicholasville: the scrape's 1% was the COUNTY rate — the city's own is 1.5%", () => {
      // Jessamine County withholds 1% county-wide; the City of
      // Nicholasville levies its own 1.5% on top, and the two stack.
      // Carrying the county figure as the city rate under-withheld by a
      // third for everyone working there.
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Nicholasville' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(15.0));
    });

    test('Florence: a real gap the SOS scrape missed entirely -- its wage tax (2%) is a SEPARATE levy from the tiny 0.001% Gross Receipts figure on file', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'KY', certificate: { workCity: 'Florence' } },
        }),
      );
      assert.equal(amountOf(r, 'KY_LOCAL'), dollars(20.0));
    });

    // Walton and Florence (KRS 68.197(10)(c)): the two confirmed real-world
    // uses of the SS-wage-base-cap variant. Fixed a real typo while wiring
    // Walton's ($184,500 is the actual 2026 SS wage base, cross-checked
    // against data/federal/2026.json -- the data file previously said
    // $84,500).
    describe('SS-wage-base cap (KRS 68.197(10)(c))', () => {
      test('Walton: room still available under the cap: only the portion up to the cap is taxed', () => {
        // $184,500 SS wage base - $184,000 YTD = $500 of room this period,
        // even though $1,000 was earned. 500 x 2% = $10.00, not 1,000 x 2% = $20.00.
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            workState: { code: 'KY', certificate: { workCity: 'Walton' } },
            ytd: {
              socialSecurity: 0,
              medicare: 0,
              futa: 0,
              localIncomeTax: { KY_LOCAL_Walton: dollars(184000) },
            },
          }),
        );
        assert.equal(amountOf(r, 'KY_LOCAL'), dollars(10.0));
      });

      test('Walton: already past the cap: $0, not the flat 2%', () => {
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            workState: { code: 'KY', certificate: { workCity: 'Walton' } },
            ytd: {
              socialSecurity: 0,
              medicare: 0,
              futa: 0,
              localIncomeTax: { KY_LOCAL_Walton: dollars(184500) },
            },
          }),
        );
        assert.equal(amountOf(r, 'KY_LOCAL'), 0);
      });

      test('Florence: also capped, tracked independently of Walton', () => {
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            workState: { code: 'KY', certificate: { workCity: 'Florence' } },
            ytd: {
              socialSecurity: 0,
              medicare: 0,
              futa: 0,
              localIncomeTax: { KY_LOCAL_Florence: dollars(184500) },
            },
          }),
        );
        assert.equal(amountOf(r, 'KY_LOCAL'), 0);
      });

      test('a different KY jurisdiction is NOT capped — Carlisle keeps taxing the full amount regardless of YTD', () => {
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            workState: { code: 'KY', certificate: { workCity: 'Carlisle' } },
            ytd: {
              socialSecurity: 0,
              medicare: 0,
              futa: 0,
              localIncomeTax: { KY_LOCAL_Carlisle: dollars(500000) },
            },
          }),
        );
        assert.equal(amountOf(r, 'KY_LOCAL'), dollars(10.0));
      });
    });

    // Bardwell's ordinance caps the tax at $1,000 per employee a year; at
    // its 1% rate that is the first $100,000 of wages.
    describe('a city-set dollar cap (Bardwell, $1,000 of tax at 1%)', () => {
      const bardwell = (ytdWages: number, checkDate = '2026-06-15') =>
        calculatePaycheck(
          input({
            checkDate,
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            workState: { code: 'KY', certificate: { workCity: 'Bardwell' } },
            ytd: { socialSecurity: 0, medicare: 0, futa: 0, localIncomeTax: { KY_LOCAL_Bardwell: dollars(ytdWages) } },
          }),
        );

      test('under the cap: full 1%', () => {
        assert.equal(amountOf(bardwell(50_000), 'KY_LOCAL'), dollars(10.0));
      });

      test('crossing the cap: only the wages up to $100,000 are taxed', () => {
        // $99,600 YTD leaves $400 of room: 400 x 1% = $4.00.
        assert.equal(amountOf(bardwell(99_600), 'KY_LOCAL'), dollars(4.0));
      });

      test('past the cap: $0', () => {
        assert.equal(amountOf(bardwell(100_000), 'KY_LOCAL'), 0);
      });

      test('2025 is not capped: the rate changed mid-year, so no single wage cap equals the tax cap', () => {
        assert.equal(amountOf(bardwell(150_000, '2025-12-05'), 'KY_LOCAL'), dollars(10.0));
      });
    });
  });
});

describe('gross-to-net', () => {
  test('net pay reconciles and excludes employer taxes', () => {
    const r = calculatePaycheck(input());
    assert.equal(r.grossPay, dollars(3000));
    // FIT 320.38 + SS 186.00 + Medicare 43.50 = 549.88
    assert.equal(r.employeeTaxTotal, dollars(549.88));
    // SS 186.00 + Medicare 43.50 + FUTA 18.00 = 247.50
    assert.equal(r.employerTaxTotal, dollars(247.5));
    assert.equal(r.netPay, dollars(2450.12));
    assert.equal(
      r.netPay,
      r.grossPay - r.pretaxDeductions - r.posttaxDeductions - r.employeeTaxTotal,
    );
  });

  test('imputed income is taxed but not paid; reimbursements are paid but not taxed', () => {
    const r = calculatePaycheck(
      input({
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(2000) },
          { code: 'GTL', category: 'imputed', amount: dollars(50) },
          { code: 'MILEAGE', category: 'reimbursement', amount: dollars(100) },
        ],
      }),
    );
    // Cash out the door: 2,000 + 100 reimbursement.
    assert.equal(r.grossPay, dollars(2100));
    // Medicare base: 2,000 + 50 imputed, reimbursement excluded.
    assert.equal(
      r.taxes.find((t) => t.id === 'US_MED_EE')!.taxableWages,
      dollars(2050),
    );
  });

  test('post-tax deductions reduce net but no taxable base', () => {
    const r = calculatePaycheck(
      input({
        deductions: [{ code: 'GARNISH', category: null, amount: dollars(150) }],
      }),
    );
    assert.equal(amountOf(r, 'US_FIT'), dollars(320.38)); // unchanged
    assert.equal(r.netPay, dollars(2450.12) - dollars(150));
  });

  test('whole-dollar rounding is opt-in', () => {
    const r = calculatePaycheck(input({ roundToWholeDollars: true }));
    assert.equal(amountOf(r, 'US_FIT'), dollars(320));
  });
});

describe('Minnesota', () => {
  // Expected values hand-derived from wh-inst-26's "Computer Formula" (p.34)
  // before the code was run, same discipline as every other state. Unlike
  // Wisconsin's single shared bracket schedule, Minnesota publishes TWO
  // different schedules (single vs. married) — these fixtures deliberately
  // exercise both. Minnesota's own tables round to the WHOLE dollar; these
  // fixtures compute to the CENT via the underlying formula instead (the
  // tables are just a rounded presentation of the same formula, not a
  // separately authoritative source — wh-inst-26 itself says rounding to
  // the whole dollar is optional, "You may round...").
  const mnState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'MN', certificate },
  });

  test('single, weekly $605, 0 allowances', () => {
    // Annual 605x52=31,460. No allowance. Net wage 31,460 falls in the
    // 4,700-38,010 bracket (5.35%, base $0). Excess: 31,460-4,700=26,760.
    // Tax: 5.35% x 26,760 = 1,431.66/yr ÷ 52 = 27.5319... → $27.53.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
        ...mnState({ maritalStatus: 'single', allowances: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), dollars(27.53));
  });

  test('single, weekly $605, 2 allowances — same bracket, allowance lowers the base', () => {
    // Annual 31,460. Allowance: 2x$5,300=$10,600. Net: 31,460-10,600=20,860
    // — still the 4,700-38,010 bracket. Excess: 20,860-4,700=16,160.
    // Tax: 5.35% x 16,160 = 864.56/yr ÷ 52 = 16.6262... → $16.63.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
        ...mnState({ maritalStatus: 'single', allowances: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), dollars(16.63));
  });

  test('married, weekly $905, 3 allowances — uses the MARRIED bracket schedule', () => {
    // Annual 905x52=47,060. Allowance: 3x$5,300=$15,900. Net: 47,060-15,900
    // =31,160 — married's 14,700-63,400 bracket (5.35%, base $0), a
    // DIFFERENT threshold than single's, proving the two schedules are
    // genuinely distinct, not the same table reused. Excess: 31,160-14,700
    // =16,460. Tax: 5.35% x 16,460 = 880.61/yr ÷ 52 = 16.9348... → $16.93.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(905) }],
        ...mnState({ maritalStatus: 'married', allowances: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), dollars(16.93));
  });

  test('zero or negative net wage after allowances withholds nothing', () => {
    // Weekly $80, 1 allowance. Annual 80x52=4,160. Allowance $5,300 exceeds
    // annual wages entirely — net wage clamps to $0, landing in the 0%
    // band (0-4,700). No tax withheld, not a crash or negative amount.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(80) }],
        ...mnState({ maritalStatus: 'single', allowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), 0);
  });

  test('supplemental (bonus) wages use ONE flat 6.25% rate, unlike Wisconsin\'s bracket-dependent rate', () => {
    // Biweekly $2,000 regular + $500 bonus, single, 1 allowance.
    // Regular line excludes the bonus from its own base: annual 2,000x26=
    // 52,000. Allowance $5,300. Net: 46,700 — the 38,010-114,130 bracket
    // (6.80%, base $1,782.09). Excess: 46,700-38,010=8,690.
    // Tax: 1,782.09 + 6.80% x 8,690 = 1,782.09+590.92 = 2,373.01/yr ÷ 26 =
    // 91.269615... → $91.27 (9126.96 cents rounds to 9127).
    // Supplemental line: flat 6.25% of $500 = $31.25 — no bracket lookup at
    // all, unlike Wisconsin's bracketSupplementalTax().
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(2000) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(500) },
        ],
        ...mnState({ maritalStatus: 'single', allowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), dollars(91.27));
    assert.equal(amountOf(r, 'MN_SIT_SUPP'), dollars(31.25));
  });

  test('no supplemental line at all when there is no supplemental income', () => {
    const r = calculatePaycheck(input(mnState({ maritalStatus: 'single', allowances: 1 })));
    assert.equal(r.taxes.some((t) => t.id === 'MN_SIT_SUPP'), false);
  });

  test('BUG FIX: a pretax deduction exceeding regular wages spills onto the supplemental base too', () => {
    // $200 regular, $600 401(k) deferral (exceeds regular by $400), $500
    // bonus. Combined taxable = 200+500-600 = $100. Before this fix, the
    // bonus was taxed on the raw, un-reduced $500 instead of $100.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(200) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(500) },
        ],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(600) }],
        ...mnState({ maritalStatus: 'single', allowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), 0);
    assert.equal(amountOf(r, 'MN_SIT_SUPP'), dollars(6.25)); // 100 × 6.25%, not 500 × 6.25%
  });

  test('certificate.exempt zeroes BOTH the regular and supplemental lines (Form W-4MN Section 2)', () => {
    // Biweekly $2,000 regular + $500 bonus, single, 1 allowance — same
    // wages as the earlier supplemental fixture, which produced MN_SIT
    // $91.27 and MN_SIT_SUPP $31.25 with exempt unset. With exempt:true,
    // both lines must be $0 instead — Section 2 covers all MN wages, not
    // just regular pay. Lines stay PRESENT (zeroed), not removed, so a
    // caller inspecting result.taxes always finds the same set of ids.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(2000) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(500) },
        ],
        ...mnState({ maritalStatus: 'single', allowances: 1, exempt: true }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), 0);
    assert.equal(amountOf(r, 'MN_SIT_SUPP'), 0);
  });

  test('certificate.exempt as the STRING "false" throws instead of silently zeroing state tax — truthy is not the same as true', () => {
    // The real risk this guards against: a caller serializing a boolean as
    // a string (a form field, a DB column, JSON) sends "false" meaning
    // "not exempt" — but "false" is truthy in JavaScript, so a bare `if
    // (cert.exempt)` check would have silently withheld $0 of state tax
    // for an employee who never claimed exemption.
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
            ...mnState({ maritalStatus: 'single', allowances: 0, exempt: 'false' }),
          }),
        ),
      /Unrecognized certificate\.exempt/,
    );
  });

  test('certificate.exempt as a real boolean false withholds normally, not exempt', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
        ...mnState({ maritalStatus: 'single', allowances: 0, exempt: false }),
      }),
    );
    assert.ok(amountOf(r, 'MN_SIT') > 0);
  });

  test('certificate.additionalWithholding adds a flat per-period amount on top of the formula (W-4MN Section 1 Line 2)', () => {
    // Same base case as 'single, weekly $605, 0 allowances' ($27.53),
    // plus a $10.00 additional withholding request. Expect $37.53 —
    // added to MN_SIT only, not duplicated onto a supplemental line.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
        ...mnState({ maritalStatus: 'single', allowances: 0, additionalWithholding: dollars(10) }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), dollars(37.53));
  });

  test('additionalWithholding is skipped entirely when the employee is also exempt', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
        ...mnState({ maritalStatus: 'single', allowances: 0, exempt: true, additionalWithholding: dollars(10) }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), 0);
  });

  test('reciprocity: a Michigan resident working in Minnesota owes $0 MN income tax', () => {
    // Same wages as the base fixture ($605/wk, single, 0 allowances,
    // which normally withholds $27.53) but residenceState:MI — one of
    // MN's two active reciprocal states (data/states/MN-2026.json
    // reciprocity.reciprocalStates). Expect MN_SIT to drop to $0 purely
    // from residence, with no change to the earnings themselves.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
        residenceState: { code: 'MI' },
        ...mnState({ maritalStatus: 'single', allowances: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), 0);
  });

  test('reciprocity does NOT apply when residenceState equals the work state', () => {
    // Guards against a degenerate case: a Minnesota resident working in
    // Minnesota must NOT match its own state code in reciprocalStates
    // (which it isn't in anyway) — normal $27.53 withholding applies.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
        residenceState: { code: 'MN' },
        ...mnState({ maritalStatus: 'single', allowances: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), dollars(27.53));
  });

  test('reciprocity does NOT apply to a non-reciprocal-state resident (Wisconsin\'s agreement is not currently active)', () => {
    // Wisconsin is named in Rule 8002.0200 but its actual agreement is
    // terminated (see reciprocity.reciprocalStatesEligibleButNotCurrentlyActive
    // in the data file) — MN-2026.json's reciprocalStates deliberately
    // excludes WI, so a Wisconsin resident still owes ordinary MN tax.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
        residenceState: { code: 'WI' },
        ...mnState({ maritalStatus: 'single', allowances: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), dollars(27.53));
  });

  test('nonresident de minimis: low annual wages waive MN withholding even without reciprocity', () => {
    // Weekly $200, single, residenceState CA (not a reciprocal state).
    // Annual estimate: 200x52=10,400 — below MN's $15,300 nonresident
    // de minimis threshold (wh-inst-26 p.4) — so MN_SIT is $0 even though
    // CA has no reciprocal agreement with MN at all.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
        residenceState: { code: 'CA' },
        ...mnState({ maritalStatus: 'single', allowances: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), 0);
  });

  test('nonresident de minimis does NOT waive withholding once estimated annual wages reach the threshold', () => {
    // Weekly $300, residenceState CA. Annual estimate: 300x52=15,600 —
    // AT/ABOVE the $15,300 threshold, so ordinary withholding applies:
    // net wage 15,600 falls in the 4,700-38,010 bracket. Excess:
    // 15,600-4,700=10,900. Tax: 5.35% x 10,900 = 583.15/yr ÷ 52 =
    // 11.2144... → $11.21.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(300) }],
        residenceState: { code: 'CA' },
        ...mnState({ maritalStatus: 'single', allowances: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), dollars(11.21));
  });

  test('nonresident alien: Form W-4MN routes to Pub 15-T Table 2, reusing the SAME federal table as US_FIT', () => {
    // Same $605/wk, single, 0-allowance base as 'single, weekly $605, 0
    // allowances' ($27.53), plus certificate.nonresidentAlien:true. Table 2
    // weekly = $309.60. Adjusted per-period wages: 605+309.60=914.60 ->
    // annual 914.60x52=47,559.20 (no allowance to subtract) -> falls in
    // the 38,010-114,130 bracket (6.80%, base $1,782.09), NOT the
    // 4,700-38,010 bracket the unadjusted $605/wk wage falls in. Excess:
    // 47,559.20-38,010=9,549.20. Tax: 1,782.09+6.80%x9,549.20=1,782.09+
    // 649.3456=2,431.4356/yr -> /52 = 46.758... -> $46.76.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
        ...mnState({ maritalStatus: 'single', allowances: 0, nonresidentAlien: true }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), dollars(46.76));
  });

  test('an unrecognized certificate.maritalStatus throws instead of silently defaulting to single', () => {
    // A caller passing the raw W-4MN checkbox label, or any typo, must fail
    // loudly rather than produce a plausible-looking wrong number by
    // silently falling through to 'single'.
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
            ...mnState({ maritalStatus: 'divorced', allowances: 0 }),
          }),
        ),
      /Unrecognized MN certificate\.maritalStatus/,
    );
  });

  test("the third checkbox ('married_withhold_as_single') resolves to the SINGLE schedule, not married", () => {
    // Married, weekly $905, 3 allowances, but withholding at the higher
    // single rate — same wages as the earlier 'married, weekly $905, 3
    // allowances' fixture, which used the MARRIED schedule and got $16.93.
    // With this checkbox, the SAME wages must land on the SINGLE schedule
    // instead: annual 47,060 - 15,900 allowance = 31,160 net -> single's
    // 4,700-38,010 bracket (5.35%, base $0), not married's 14,700-63,400
    // bracket. Excess: 31,160-4,700=26,460. Tax: 5.35% x 26,460 = 1,415.61/yr
    // -> /52 = 27.223... -> $27.22 — a DIFFERENT number than $16.93,
    // proving this really did switch schedules, not just relabel the same one.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(905) }],
        ...mnState({ maritalStatus: 'married_withhold_as_single', allowances: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'MN_SIT'), dollars(27.22));
  });

  describe('Minnesota Paid Leave (employee)', () => {
    test('0.44% of wages, no cap in play', () => {
      // Weekly $605 — same wages as the base income-tax fixture.
      // 605 x 0.44% = 2.662 -> rounds to $2.66.
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
          ...mnState({ maritalStatus: 'single', allowances: 0 }),
        }),
      );
      assert.equal(amountOf(r, 'MN_PFML_EE'), dollars(2.66));
    });

    test('runs even when MN income tax is $0 via reciprocity — separate statute, separate levy', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
          residenceState: { code: 'MI' },
          ...mnState({ maritalStatus: 'single', allowances: 0 }),
        }),
      );
      assert.equal(amountOf(r, 'MN_SIT'), 0);
      assert.equal(amountOf(r, 'MN_PFML_EE'), dollars(2.66));
    });

    test('caps at the wage base using YTD, not just the current cheque', () => {
      // $184,900 already counted YTD toward MN's Paid Leave cap ($185,000).
      // Only $100 of this week's $605 is still under the cap.
      // 100 x 0.44% = 0.44 -> $0.44.
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
          ytd: {
            socialSecurity: 0,
            medicare: 0,
            futa: 0,
            statePaidLeave: { MN: dollars(184900) },
          },
          ...mnState({ maritalStatus: 'single', allowances: 0 }),
        }),
      );
      assert.equal(amountOf(r, 'MN_PFML_EE'), dollars(0.44));
    });
  });
});

describe('Montana', () => {
  // Expected values reproduce the Employer and Information Agent Guide's OWN
  // worked examples exactly — not values computed only by this engine. This
  // is the strongest verification tier available: Montana's guide gives its
  // own answer for each example, so these fixtures prove the engine agrees
  // with the primary source's own arithmetic, not just with itself.
  const mtState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'MT', certificate },
  });

  test('Guide Example: single/MFS, semi-monthly $1,375 -> $33', () => {
    // $0 + 4.7% x ($1,375-$671) = $33.088 -> $33 (nearest dollar, not $34 —
    // proves this engine follows the guide's own examples, not its prose).
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1375) }],
        ...mtState({ filingStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(33));
  });

  test('Guide Example: single/MFS, biweekly $2,950 -> $114', () => {
    // $86 + 5.65% x ($2,950-$2,446) = $114.476 -> $114.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2950) }],
        ...mtState({ filingStatus: 'mfs' }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(114));
  });

  test('Guide Example: single/MFS, weekly $475 -> $8', () => {
    // $0 + 4.7% x ($475-$310) = $7.755 -> $8.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(475) }],
        ...mtState({ filingStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(8));
  });

  test('Guide Example: MFJ/QSS, semi-monthly $1,375 -> $2', () => {
    // $0 + 4.7% x ($1,375-$1,342) = $1.551 -> $2.
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1375) }],
        ...mtState({ filingStatus: 'mfj' }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(2));
  });

  test('Guide Example: MFJ/QSS, biweekly $5,950 -> $232', () => {
    // $172 + 5.65% x ($5,950-$4,892) = $231.777 -> $232.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5950) }],
        ...mtState({ filingStatus: 'qss' }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(232));
  });

  test('Guide Example: MFJ/QSS, weekly $725 -> $5', () => {
    // $0 + 4.7% x ($725-$619) = $4.982 -> $5.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(725) }],
        ...mtState({ filingStatus: 'mfj' }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(5));
  });

  test('Guide Example: Head of Household, semi-monthly $1,375 -> $17', () => {
    // $0 + 4.7% x ($1,375-$1,006) = $17.343 -> $17.
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1375) }],
        ...mtState({ filingStatus: 'hoh' }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(17));
  });

  test('both-spouses-working reuses the single/MFS table, not a fourth schedule', () => {
    // MFJ + bothSpousesWorking, semi-monthly $1,375 — MUST match the
    // single/MFS example ($33), NOT the MFJ/QSS example ($2), proving
    // resolveMTSchedule() actually redirects to single_mfs_bothWorking
    // rather than just relabeling the MFJ table.
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1375) }],
        ...mtState({ filingStatus: 'mfj', bothSpousesWorking: true }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(33));
  });

  test('no certificate defaults to single, matching Form MW-4\'s own stated fallback', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1375) }],
        workState: { code: 'MT' },
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(33));
  });

  test('an unrecognized certificate.filingStatus throws', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(475) }],
            ...mtState({ filingStatus: 'divorced' }),
          }),
        ),
      /Unrecognized MT certificate\.filingStatus/,
    );
  });

  test('MW-4 line 4 (specified withholding) fully replaces the bracket calculation', () => {
    // Same wages as the $33 example, but specifiedWithholding overrides it —
    // must produce $75, NOT $33, and must suppress the supplemental line too.
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(1375) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(500) },
        ],
        ...mtState({ filingStatus: 'single', specifiedWithholding: dollars(75) }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(75));
    assert.equal(r.taxes.some((t) => t.id === 'MT_SIT_SUPP'), false);
  });

  test('supplemental wages use flat 5% (Method 3), separate from the regular bracket line', () => {
    // Regular $1,375 semi-monthly (single) -> $33, same as the base example
    // since the regular line carves supplemental out of its own base.
    // Supplemental $500 x 5% = $25.
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(1375) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(500) },
        ],
        ...mtState({ filingStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(33));
    assert.equal(amountOf(r, 'MT_SIT_SUPP'), dollars(25));
  });

  test('BUG FIX: a pretax deduction exceeding regular wages spills onto the supplemental base too', () => {
    // $200 regular, $600 401(k) deferral (exceeds regular by $400), $500
    // bonus. Combined taxable = 200+500-600 = $100. Before this fix, the
    // bonus was taxed on the raw, un-reduced $500 instead of $100.
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(200) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(500) },
        ],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(600) }],
        ...mtState({ filingStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), 0);
    assert.equal(amountOf(r, 'MT_SIT_SUPP'), dollars(5)); // 100 × 5%, not 500 × 5%
  });

  test('reciprocity: a North Dakota resident working in Montana owes $0 MT income tax', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1375) }],
        residenceState: { code: 'ND' },
        ...mtState({ filingStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), 0);
  });

  test('certificate.exempt (MW-4 line 5) zeroes MT_SIT generically, same mechanism as every other state', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(475) }],
        ...mtState({ filingStatus: 'single', exempt: true }),
      }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), 0);
  });

  test('a quarterly pay frequency, which Montana does not publish a table for, throws rather than guessing', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'quarterly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(4000) }],
            ...mtState({ filingStatus: 'single' }),
          }),
        ),
      /don't publish a "quarterly" schedule/,
    );
  });
});

describe('New York', () => {
  // Expected values hand-derived from NYS-50-T-NYS's own worked examples and
  // published tables, same discipline as every other state. New York is the
  // first state in this project where the deduction/exemption allowance is a
  // single precomputed per-period/per-status/per-count lookup (Table A)
  // rather than a flat per-exemption multiplier, AND where the bracket table
  // itself is published separately per pay frequency with no annualization
  // step for ordinary earners — Method III (a flat rate on ANNUALIZED net
  // wages) only kicks in for very high earners.
  const nyState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'NY', certificate },
  });

  test('NYS-50-T-NYS Example 1: weekly $400, single, 3 exemptions', () => {
    // Table A: $200.05. Net: 400-200.05=199.95. Weekly single bracket
    // 163-267 has TWO rows in the published table for that span (225 is a
    // sub-boundary) -- 199.95 falls in [163,225): base $0, rate 4.40%,
    // subtract $163. (199.95-163)*0.0440=1.6258 -> +6.38 base = $8.0058
    // -> $8.01 (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...nyState({ maritalStatus: 'single', exemptions: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(8.01));
  });

  test('BUG FIX: 401(k)/section-125/HSA/etc. pretax deductions reduce the NY_SIT base, not the full gross', () => {
    // NY-2026.json's own top-level exemptPretax field was missing entirely
    // until this fix, silently defaulting to an empty list — every NY
    // paycheck with a pretax deduction was taxed on the FULL gross amount.
    // Biweekly $2,000 regular, $500 401(k) deferral, single, 1 exemption.
    // Taxable = 2,000-500 = $1,500. Table A allowance $323.10 (biweekly,
    // single, 1 exemption). Net = 1,500-323.10 = $1,176.90, in the
    // [535,1614) bracket: base $22.54 + 5.40% × (1,176.90-535) = 22.54 +
    // 34.66260 = $57.20 (rounded).
    const withDeferral = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(500) }],
        ...nyState({ maritalStatus: 'single', exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(withDeferral, 'NY_SIT'), dollars(57.2));

    // Cross-check: identical to a plain $1,500 paycheck with no deferral at
    // all — proving the deferral genuinely reduced the base rather than
    // coincidentally landing on the same number some other way.
    const plainFifteenHundred = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1500) }],
        ...nyState({ maritalStatus: 'single', exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(withDeferral, 'NY_SIT'), amountOf(plainFifteenHundred, 'NY_SIT'));
  });

  test('NYS-50-T-NYS Example 2: semimonthly $5,000, single, 1 exemption', () => {
    // Table A: $350.00. Net: 5,000-350=4,650. Falls in [4,485,6,569): base
    // $246.08, rate 7.53%, subtract $4,485. (4,650-4,485)*0.0753=12.4245 ->
    // nearest-cent rounds to $12.42, not $12.43 (12.4245 is below the
    // 12.425 halfway point) -> +246.08 = $258.50.
    //
    // NYS-50-T-NYS's OWN printed example states $12.43 and a final $258.51
    // -- a genuine $0.01 rounding slip in the SOURCE's own worked example
    // (165.00 x 0.0753 = 12.4245 rounds to 12.42 under ordinary nearest-cent
    // rounding, not 12.43), the same category of source imprecision already
    // documented and corrected for in this project (Kentucky's biweekly
    // example: 'corrected to $47.98 from the source's own truncated $47').
    // Verified two independent ways this session: by hand, and by NOT
    // rounding the intermediate step at all (165x0.0753=12.4245, +246.08=
    // 258.5045, which itself rounds to $258.50, not $258.51 either way).
    // This engine computes the mathematically correct $258.50.
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...nyState({ maritalStatus: 'single', exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(258.50));
  });

  test('NYS-50-T-NYS Example 3: monthly $50,000, single, 3 exemptions', () => {
    // Table A: $866.60. Net: 50,000-866.60=49,133.40. Falls in
    // [22,117,89,796): base $1,590.92, rate 7.35%, subtract $22,117.
    // (49,133.40-22,117)*0.0735=1,985.7057 -> +1,590.92 = $3,576.6257 ->
    // $3,576.63 (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(50000) }],
        ...nyState({ maritalStatus: 'single', exemptions: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(3576.63));
  });

  test('NYS-50-T-NYS Example 4: daily $750, single, 2 exemptions', () => {
    // Table A: $36.15. Net: 750-36.15=713.85. Falls in [606,828): base
    // $37.20, rate 6.40%, subtract $606. (713.85-606)*0.0640=6.9024 ->
    // +37.20 = $44.1024 -> $44.10 (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'daily',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(750) }],
        ...nyState({ maritalStatus: 'single', exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(44.10));
  });

  test('married uses a genuinely different schedule than single, not just a relabeled one', () => {
    // Weekly $2,000, married, 2 exemptions. Table A (married, weekly, 2
    // exemptions): $191.40. Net: 2,000-191.40=1,808.60. Married weekly
    // bracket [1,551,1,862): base $80.58, rate 5.90%, subtract $1,551.
    // (1,808.60-1,551)*0.0590=15.1994 -> +80.58 = $95.7794 -> $95.78.
    // (The SINGLE schedule's [1,551,1,862) row has the same rate/base by
    // coincidence at this particular bracket, so this fixture deliberately
    // does NOT prove schedule divergence by itself -- see the next test for
    // that proof instead, at a bracket where the two schedules genuinely
    // differ.)
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...nyState({ maritalStatus: 'married', exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(95.78));
  });

  test('married and single schedules genuinely diverge at a higher bracket', () => {
    // Weekly $4,500, single vs married, 0 exemptions each -- picked
    // specifically because single's [4,142,5,104) bracket (11.44% off a
    // $257.10 base) and married's [4,068,6,215) bracket (6.40% off a
    // $263.62 base) cover this wage differently.
    // Single: Table A(single,weekly,0)=$142.30. Net=4,500-142.30=4,357.70.
    // Falls in single's [4,142,5,104): base $257.10, rate 11.44%, subtract
    // $4,142. Excess=$215.70; 21570 cents x 0.1144=2467.608 cents, rounds to
    // 2468 cents ($24.68) at THIS step (the engine rounds each applyRate()
    // call, not just the final sum) -> +$257.10 = $281.78.
    // Married: Table A(married,weekly,0)=$152.90. Net=4,500-152.90=4,347.10.
    // Falls in married's [4,068,6,215): base $263.62, rate 6.40%, subtract
    // $4,068. Excess=$279.10; 27910 cents x 0.0640=1786.24, rounds to 1786
    // cents ($17.86) -> +$263.62 = $281.48. Genuinely different from
    // single's $281.78, proving the two schedules are not the same table
    // under a different label.
    const rSingle = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(4500) }],
        ...nyState({ maritalStatus: 'single', exemptions: 0 }),
      }),
    );
    const rMarried = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(4500) }],
        ...nyState({ maritalStatus: 'married', exemptions: 0 }),
      }),
    );
    assert.equal(amountOf(rSingle, 'NY_SIT'), dollars(281.78));
    assert.equal(amountOf(rMarried, 'NY_SIT'), dollars(281.48));
  });

  test("third checkbox ('married_withhold_at_higher_single_rate' via 'married_withhold_as_single') resolves to the SINGLE schedule", () => {
    // Same $4,500/week, 0 exemptions as the single case above -- proves the
    // third checkbox maps correctly, not a NEW number.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(4500) }],
        ...nyState({ maritalStatus: 'married_withhold_as_single', exemptions: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(281.78));
  });

  test('an unrecognized certificate.maritalStatus throws instead of silently defaulting to single', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            ...nyState({ maritalStatus: 'divorced', exemptions: 0 }),
          }),
        ),
      /Unrecognized NY certificate\.maritalStatus/,
    );
  });

  test('more than 10 exemptions extrapolates linearly from Table A, per NY\'s own Table B+C method', () => {
    // Weekly $400, single, 11 exemptions. Table A only publishes 0-10;
    // index 10 is $334.80, index 9 is $315.55, a $19.25 per-exemption
    // increment confirmed constant across the whole published table.
    // Allowance(11) = 334.80 + 19.25*(11-10) = $354.05. Net = 400-354.05=
    // $45.95 -> falls in [0,163): base $0, rate 3.90%. 45.95*0.039=1.79205
    // -> $1.79.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...nyState({ maritalStatus: 'single', exemptions: 11 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(1.79));
  });

  test('a negative exemptions count throws rather than silently reading a nonsense index', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            ...nyState({ maritalStatus: 'single', exemptions: -1 }),
          }),
        ),
      /non-negative integer/,
    );
  });

  test('nonresidentAlien flag has NO effect on NY -- unlike Minnesota, NY has no sourced NRA instruction to apply', () => {
    // Same $605/wk single 0-exemption base as the ordinary case, WITH
    // certificate.nonresidentAlien:true set. Deliberately proves this flag
    // is a no-op for New York: neither NYS-50-T-NYS nor IT-2104 mentions
    // nonresident aliens anywhere, so this engine does NOT apply Minnesota's
    // Pub 15-T Table 2 adjustment here — doing so without an NY-specific
    // source would risk a confidently-wrong number. Ordinary calculation:
    // Table A (single,weekly,0)=$142.30. Net=605-142.30=462.70 -> falls in
    // [267,1551): base $11.27, rate 5.40%. (462.70-267)*0.0540=10.5678 ->
    // +11.27 = $21.8378 -> $21.84.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
        ...nyState({ maritalStatus: 'single', exemptions: 0, nonresidentAlien: true }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(21.84));
  });

  test('Method III: a very high weekly wage triggers the flat-rate-on-annualized-wages fallback', () => {
    // Weekly $21,000, single, 0 exemptions. Table A: $142.30. Net:
    // 21,000-142.30=20,857.70 -- ABOVE single's top bounded bracket
    // ($20,722), so Method III applies. Annualized: 20,857.70*52=
    // 1,084,600.40 -- falls in Method III's first single tier
    // ($1,077,550-$5,000,000 @ 10.45%). Annual tax: 1,084,600.40*0.1045=
    // 113,340.7418 -> $113,340.74. Per-week: 113,340.74/52=2,179.6296...
    // -> $2,179.63.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(21000) }],
        ...nyState({ maritalStatus: 'single', exemptions: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(2179.63));
  });

  test('supplemental wages use New York\'s flat 11.70% rate, separate from the regular-wages bracket lookup', () => {
    // Biweekly $2,000 regular + $1,000 bonus, single, 2 exemptions.
    // Regular line excludes the bonus from its own base: Table A
    // (single,biweekly,2)=$361.60. Net=2,000-361.60=1,638.40. Falls in
    // [535,3,102): base $22.54, rate 5.40%, subtract $535.
    // (1,638.40-535)*0.0540=59.5836 -> +22.54 = $82.1236 -> $82.12.
    // Supplemental line: 1,000*11.70%=$117.00 flat, no bracket lookup.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(2000) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
        ],
        ...nyState({ maritalStatus: 'single', exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(82.12));
    assert.equal(amountOf(r, 'NY_SIT_SUPP'), dollars(117.00));
  });

  test('no supplemental line at all when there is no supplemental income', () => {
    const r = calculatePaycheck(
      input(nyState({ maritalStatus: 'single', exemptions: 0 })),
    );
    assert.equal(r.taxes.some((t) => t.id === 'NY_SIT_SUPP'), false);
  });

  test('zero wages after the allowance is subtracted withholds $0, not negative', () => {
    // Weekly $100, single, 5 exemptions. Table A (single,weekly,5)=$238.55,
    // which exceeds the $100 gross wage entirely.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(100) }],
        ...nyState({ maritalStatus: 'single', exemptions: 5 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), 0);
  });

  // NYS-50: withholding on household-employee wages is VOLUNTARY, not
  // mandatory-then-excluded — the default is $0, but an asserted agreement
  // flips it back to ordinary withholding.
  describe('Household employees (voluntary withholding)', () => {
    test('no agreement asserted: $0 NY_SIT by default', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
          workState: { code: 'NY' },
          employmentCategory: 'household',
        }),
      );
      assert.equal(amountOf(r, 'NY_SIT'), 0);
    });

    test('certificate.voluntaryWithholdingAgreement flips it back to ordinary withholding', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
          workState: { code: 'NY', certificate: { voluntaryWithholdingAgreement: true } },
          employmentCategory: 'household',
        }),
      );
      assert.ok(amountOf(r, 'NY_SIT') > 0);
    });

    test('a standard employee is unaffected by this mechanism', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
          workState: { code: 'NY' },
        }),
      );
      assert.ok(amountOf(r, 'NY_SIT') > 0);
    });
  });
});

describe('New York City', () => {
  // Expected values reproduce NYS-50-T-NYC's own 8 worked examples (4
  // single, 4 married) exactly, same discipline as every other state. NYC
  // is a genuine LOCAL tax (jurisdiction:'local') layered on NY_SIT, only
  // computed for certificate.nycResident:true.
  const nycState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'NY', certificate: { ...certificate, nycResident: true } },
  });

  test('NYS-50-T-NYC Example 1 (single): weekly $400, single, 3 exemptions', () => {
    // Table A: $153.90. Net: 400-153.90=246.10. Falls in [167,288): base
    // $3.54, rate 3.25%, subtract $167. (246.10-167)*0.0325=2.57 -> +3.54
    // = $6.11 (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...nycState({ maritalStatus: 'single', exemptions: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(6.11));
  });

  test('NYS-50-T-NYC Example 2 (single): semimonthly $5,000, single, 1 exemption', () => {
    // Table A: $250.00. Net: 5,000-250=4,750. Falls in [2,500,null): base
    // $93.17, rate 4.25%, subtract $2,500. (4,750-2,500)*0.0425=95.625 ->
    // rounds to $95.63 -> +93.17 = $188.80 (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...nycState({ maritalStatus: 'single', exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(188.80));
  });

  test('NYS-50-T-NYC Example 3 (single): monthly $50,000, single, 3 exemptions', () => {
    // Table A: $666.60. Net: 50,000-666.60=49,333.40. Falls in [5,000,null):
    // base $186.33, rate 4.25%, subtract $5,000.
    // (49,333.40-5,000)*0.0425=1,884.169 -> $1,884.17 -> +186.33 = $2,070.50
    // (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(50000) }],
        ...nycState({ maritalStatus: 'single', exemptions: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(2070.50));
  });

  test('NYS-50-T-NYC Example 4 (single): daily $750, single, 2 exemptions', () => {
    // Table A: $26.95. Net: 750-26.95=723.05. Falls in [231,null): base
    // $8.60, rate 4.25%, subtract $231. (723.05-231)*0.0425=20.9096 ->
    // rounds to $20.91 -> +8.60 = $29.51 (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'daily',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(750) }],
        ...nycState({ maritalStatus: 'single', exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(29.51));
  });

  test('NYS-50-T-NYC Example 1 (married): weekly $400, married, 4 exemptions', () => {
    // Table A: $182.75. Net: 400-182.75=217.25. Falls in [167,288): base
    // $3.54, rate 3.25%, subtract $167. (217.25-167)*0.0325=1.633125 ->
    // rounds to $1.63 -> +3.54 = $5.17 (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...nycState({ maritalStatus: 'married', exemptions: 4 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(5.17));
  });

  test('NYS-50-T-NYC Example 2 (married): semimonthly $5,000, married, 3 exemptions', () => {
    // Table A: $354.10. Net: 5,000-354.10=4,645.90. Falls in [2,500,null):
    // base $93.17, rate 4.25%, subtract $2,500.
    // (4,645.90-2,500)*0.0425=91.19075 -> rounds to $91.20 (source's own
    // rounding) -> +93.17 = $184.37 (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...nycState({ maritalStatus: 'married', exemptions: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(184.37));
  });

  test('NYS-50-T-NYC Example 3 (married): monthly $50,000, married, 3 exemptions', () => {
    // Table A: $708.20. Net: 50,000-708.20=49,291.80. Falls in [5,000,null):
    // base $186.33, rate 4.25%, subtract $5,000.
    // (49,291.80-5,000)*0.0425=1,882.4015 -> rounds to $1,882.40 -> +186.33
    // = $2,068.73 (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(50000) }],
        ...nycState({ maritalStatus: 'married', exemptions: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(2068.73));
  });

  test('NYS-50-T-NYC Example 4 (married): daily $750, married, 2 exemptions', () => {
    // Table A: $28.85. Net: 750-28.85=721.15. Falls in [231,null): base
    // $8.60, rate 4.25%, subtract $231. (721.15-231)*0.0425=20.83375 ->
    // rounds to $20.83 -> +8.60 = $29.43 (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'daily',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(750) }],
        ...nycState({ maritalStatus: 'married', exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(29.43));
  });

  test('NYC brackets are shared between single and married -- proof, not assumption', () => {
    // Same $2,000 weekly wage and 0 exemptions for both statuses, but
    // DIFFERENT Table A allowances (single $96.15 vs married $105.75), so
    // the two lines land on genuinely different net wages while running
    // through the exact same bracket table. Single: net=2,000-96.15=
    // 1,903.85 -> [1,154,null): base $43.00, rate 4.25%.
    // (1,903.85-1,154)*0.0425=31.867625 -> $31.87 -> +43.00=$74.87.
    // Married: net=2,000-105.75=1,894.25 -> SAME bracket [1,154,null).
    // (1,894.25-1,154)*0.0425=31.455625 -> $31.46 -> +43.00=$74.46.
    const rSingle = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...nycState({ maritalStatus: 'single', exemptions: 0 }),
      }),
    );
    const rMarried = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...nycState({ maritalStatus: 'married', exemptions: 0 }),
      }),
    );
    assert.equal(amountOf(rSingle, 'NY_NYC_SIT'), dollars(74.87));
    assert.equal(amountOf(rMarried, 'NY_NYC_SIT'), dollars(74.46));
  });

  test('no NY_NYC_SIT line at all when certificate.nycResident is not set', () => {
    const r = calculatePaycheck(
      input({
        workState: { code: 'NY', certificate: { maritalStatus: 'single', exemptions: 0 } },
      }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'NY_NYC_SIT'), false);
    assert.equal(r.taxes.some((t) => t.id === 'NY_NYC_SIT_SUPP'), false);
  });

  test('supplemental wages use NYC\'s flat 4.25% rate, separate from the regular-wages bracket lookup', () => {
    // Biweekly $2,000 regular + $1,000 bonus, single, 2 exemptions.
    // Regular line excludes the bonus: Table A (single,biweekly,2)=
    // $269.30. Net=2,000-269.30=1,730.70 -> falls in [962,2308): base
    // $30.12, rate 4.15%, subtract $962. (1,730.70-962)*0.0415=31.90105 ->
    // rounds to $31.90 -> +30.12 = $62.02.
    // Supplemental line: 1,000*4.25%=$42.50 flat.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(2000) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
        ],
        ...nycState({ maritalStatus: 'single', exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(62.02));
    assert.equal(amountOf(r, 'NY_NYC_SIT_SUPP'), dollars(42.50));
  });

  test('BUG FIX: a pretax deduction exceeding regular wages spills onto the supplemental base too', () => {
    // $200 regular, $900 401(k) deferral (exceeds regular by $700), $1,000
    // bonus. Combined taxable = 200+1,000-900 = $300. Before this fix, the
    // bonus was taxed on the raw, un-reduced $1,000 instead of $300.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(200) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
        ],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(900) }],
        ...nycState({ maritalStatus: 'single', exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_NYC_SIT'), 0);
    assert.equal(amountOf(r, 'NY_NYC_SIT_SUPP'), dollars(12.75)); // 300 × 4.25%, not 1,000 × 4.25%
  });

  test('nycExemptions overrides the shared exemptions count when the two genuinely differ', () => {
    // Weekly $400, single, certificate.exemptions:3 (NYS/Yonkers) but
    // certificate.nycExemptions:1 (a genuinely different Line-2 count).
    // NY_SIT should use 3 (from Example 1: $8.01 — already proven above),
    // NY_NYC_SIT should use 1: Table A (single,weekly,1)=$115.40.
    // Net=400-115.40=284.60 -> falls in [167,288): base $3.54, rate 3.25%.
    // (284.60-167)*0.0325=3.8220 -> $3.82 -> +3.54=$7.36.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...nycState({ maritalStatus: 'single', exemptions: 3, nycExemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(8.01));
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(7.36));
  });

  test('additionalWithholdingNYC (IT-2104 Line 4) adds a flat per-period amount, distinct from NYS Line 3', () => {
    // Same wages as Example 1 (weekly $400, single, 3 exemptions -> $6.11
    // base), with certificate.additionalWithholdingNYC:dollars(10) AND
    // certificate.additionalWithholding:dollars(5) (NYS's own Line 3) set
    // simultaneously, proving the two amounts land on the correct SEPARATE
    // lines rather than one overwriting or double-applying to the other.
    // NY_SIT: $8.01 (single/weekly/3-exemptions base) + $5.00 = $13.01.
    // NY_NYC_SIT: $6.11 (Example 1 base) + $10.00 = $16.11.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...nycState({
          maritalStatus: 'single',
          exemptions: 3,
          additionalWithholding: dollars(5),
          additionalWithholdingNYC: dollars(10),
        }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(13.01));
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(16.11));
  });

  test('no additionalWithholdingNYC applied when unset -- no silent phantom charge', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...nycState({ maritalStatus: 'single', exemptions: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_NYC_SIT'), dollars(6.11));
  });
});

describe('Yonkers', () => {
  // Resident surcharge examples reproduce NYS-50-T-Y's own 4 worked
  // examples, each literally "take NYS's own example answer and multiply by
  // 16.75%". Nonresident examples reproduce NYS-50-T-Y's own 3 worked
  // examples for that separate, structurally different tax.
  const residentState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'NY', certificate: { ...certificate, yonkersResident: true } },
  });
  const nonresidentWorkerState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'NY', certificate: { ...certificate, yonkersNonresidentWorker: true } },
  });

  test('resident surcharge Example 1: weekly $400, single, 3 exemptions', () => {
    // NYS base tax (proven elsewhere) = $8.01. x 16.75% = $1.34155 -> $1.34
    // (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...residentState({ maritalStatus: 'single', exemptions: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), dollars(1.34));
  });

  test('resident surcharge Example 2: semimonthly $5,000, single, 1 exemption', () => {
    // NYS base tax (this engine's OWN corrected value, $258.50, not the
    // source's slightly-off $258.51 -- see the New York describe block's
    // Example 2 note) x 16.75% = $43.30375 -> $43.30, which happens to
    // match the source's own stated Yonkers answer exactly regardless of
    // the 1-cent NYS-level difference.
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...residentState({ maritalStatus: 'single', exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), dollars(43.30));
  });

  test('resident surcharge Example 3: monthly $50,000, single, 3 exemptions -- corrects a SECOND source arithmetic slip', () => {
    // NYS base tax (proven elsewhere) = $3,576.63 exactly, matching the
    // source's own NYS example precisely. $3,576.63 x 0.1675 = 599.085525
    // precisely -- which rounds to $599.09 under ordinary nearest-cent
    // rounding (599.0855... is past the 599.085 halfway point), NOT the
    // source's own stated $599.08. This is a SECOND independent arithmetic
    // slip found in New York's own published examples this project
    // (alongside NYS-50-T-NYS's own Example 2, $258.51 vs the correct
    // $258.50) -- verified by hand before trusting the engine's answer over
    // the printed one, same discipline both times.
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(50000) }],
        ...residentState({ maritalStatus: 'single', exemptions: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), dollars(599.09));
  });

  test('resident surcharge Example 4: daily $750, single, 2 exemptions', () => {
    // NYS base tax (proven elsewhere) = $44.10. x 16.75% = $7.38675 ->
    // $7.39 (the source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'daily',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(750) }],
        ...residentState({ maritalStatus: 'single', exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), dollars(7.39));
  });

  test('resident supplemental wages use 1.95975% flat, confirmed equal to 11.70% x 16.75%', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(400) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
        ],
        ...residentState({ maritalStatus: 'single', exemptions: 3 }),
      }),
    );
    // 1,000 x 0.0195975 = 19.5975 -> $19.60.
    assert.equal(amountOf(r, 'NY_YONKERS_SIT_SUPP'), dollars(19.60));
  });

  test('BUG FIX: a pretax deduction exceeding regular wages spills onto the supplemental base too', () => {
    // $200 regular, $900 401(k) deferral (exceeds regular by $700), $1,000
    // bonus. Combined taxable = 200+1,000-900 = $300. Before this fix, the
    // bonus was taxed on the raw, un-reduced $1,000 instead of $300.
    // 300 × 1.95975% = 5.87925 -> $5.88.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(200) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
        ],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(900) }],
        ...residentState({ maritalStatus: 'single', exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), 0);
    assert.equal(amountOf(r, 'NY_YONKERS_SIT_SUPP'), dollars(5.88));
  });

  test('nonresident worker Example 1: weekly $75 -- below the no-withholding threshold', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(75) }],
        ...nonresidentWorkerState({}),
      }),
    );
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), 0);
  });

  test('nonresident worker Example 2: weekly $200', () => {
    // Falls in [192,385): exemption $38. (200-38)*0.0050=$0.81 (the
    // source's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
        ...nonresidentWorkerState({}),
      }),
    );
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), dollars(0.81));
  });

  test('nonresident worker Example 3: semimonthly $400', () => {
    // Falls in [167,417): exemption $125. (400-125)*0.0050=$1.375 -> $1.38
    // (the source's own stated answer -- exact half-cent, rounds up).
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...nonresidentWorkerState({}),
      }),
    );
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), dollars(1.38));
  });

  test('nonresident worker: wages at/above the top tier get zero exemption', () => {
    // Weekly $1,000 -- above the $577 top-tier threshold, exemption=$0.
    // 1,000 x 0.0050 = $5.00 exactly.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...nonresidentWorkerState({}),
      }),
    );
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), dollars(5.00));
  });

  test('nonresident worker supplemental wages use the same flat 0.50% as regular wages', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(1000) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
        ],
        ...nonresidentWorkerState({}),
      }),
    );
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), dollars(5.00));
    assert.equal(amountOf(r, 'NY_YONKERS_SIT_SUPP'), dollars(5.00));
  });

  test('no Yonkers line at all when neither yonkersResident nor yonkersNonresidentWorker is set', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        workState: { code: 'NY', certificate: { maritalStatus: 'single', exemptions: 3 } },
      }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'NY_YONKERS_SIT'), false);
    assert.equal(r.taxes.some((t) => t.id === 'NY_YONKERS_SIT_SUPP'), false);
  });

  test('resident status wins if a caller somehow sets both flags at once', () => {
    // Same wages as resident Example 1 ($1.34) -- if nonresident logic won
    // instead, this would compute a completely different flat-0.50%-based
    // number.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        workState: {
          code: 'NY',
          certificate: {
            maritalStatus: 'single',
            exemptions: 3,
            yonkersResident: true,
            yonkersNonresidentWorker: true,
          },
        },
      }),
    );
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), dollars(1.34));
  });

  describe('BUG FIX: yonkersResident/yonkersNonresidentWorker used to be read as bare truthy values', () => {
    // Found auditing every resident/nonresident flag in this engine for the
    // same risk resolveCertNonresident/resolveCertExempt were already
    // written to guard against (see their own doc comments): a caller who
    // sends the STRING "false" for a boolean field gets treated as true
    // under a bare `if` check, because non-empty strings are truthy in JS.
    // yonkersLocalTax() and yonkersSupplementalTax() read
    // certificate.yonkersResident/yonkersNonresidentWorker directly with no
    // such guard — a real gap given NYS-50-T-Y's own residency flags decide
    // between a 16.75%-of-NYS-tax surcharge and a completely different flat
    // nonresident rate. Both functions now go through the same
    // resolveCertBoolean() helper resolveCertExempt/resolveCertNonresident
    // already used, generalized to take a field name.
    test('yonkersResident: "false" (a string) throws rather than being silently treated as true', () => {
      assert.throws(
        () =>
          calculatePaycheck(
            input({
              payFrequency: 'weekly',
              earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
              workState: {
                code: 'NY',
                certificate: { maritalStatus: 'single', exemptions: 3, yonkersResident: 'false' },
              },
            }),
          ),
        /Unrecognized certificate\.yonkersResident/,
      );
    });

    test('yonkersNonresidentWorker: "false" (a string) throws the same way', () => {
      assert.throws(
        () =>
          calculatePaycheck(
            input({
              payFrequency: 'weekly',
              earnings: [{ code: 'REG', category: 'regular', amount: dollars(1500) }],
              workState: {
                code: 'NY',
                certificate: { maritalStatus: 'single', yonkersNonresidentWorker: 'false' },
              },
            }),
          ),
        /Unrecognized certificate\.yonkersNonresidentWorker/,
      );
    });

    test('a real boolean false on both flags correctly produces no Yonkers tax line at all', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
          workState: {
            code: 'NY',
            certificate: {
              maritalStatus: 'single',
              exemptions: 3,
              yonkersResident: false,
              yonkersNonresidentWorker: false,
            },
          },
        }),
      );
      assert.equal(r.taxes.find((t) => t.id === 'NY_YONKERS_SIT'), undefined);
    });
  });

  test('additionalWithholdingYonkers (IT-2104 Line 5) adds a flat amount for RESIDENTS, distinct from Lines 3/4', () => {
    // Same wages as resident Example 1 ($1.34 base), plus
    // certificate.additionalWithholdingYonkers:dollars(5) AND
    // certificate.additionalWithholding:dollars(2) (NYS's own Line 3) set
    // simultaneously, proving the two land on separate lines.
    // NY_SIT: $8.01 + $2.00 = $10.01. NY_YONKERS_SIT: $1.34 + $5.00 = $6.34.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...residentState({
          maritalStatus: 'single',
          exemptions: 3,
          additionalWithholding: dollars(2),
          additionalWithholdingYonkers: dollars(5),
        }),
      }),
    );
    assert.equal(amountOf(r, 'NY_SIT'), dollars(10.01));
    assert.equal(amountOf(r, 'NY_YONKERS_SIT'), dollars(6.34));
  });

  test('additionalWithholdingYonkers applies for NONRESIDENT WORKERS too, including when wages are below the threshold', () => {
    // Weekly $75 -- normally $0 (below the no-withholding floor) -- plus
    // $2.00 requested extra should still show up: Line 5 is an employee
    // request, not conditioned on the formula's own result.
    const rBelowThreshold = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(75) }],
        ...nonresidentWorkerState({ additionalWithholdingYonkers: dollars(2) }),
      }),
    );
    assert.equal(amountOf(rBelowThreshold, 'NY_YONKERS_SIT'), dollars(2.00));

    // Weekly $200 -- normally $0.81 (Example 2) -- plus $3.00 requested
    // extra = $3.81.
    const rTaxable = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
        ...nonresidentWorkerState({ additionalWithholdingYonkers: dollars(3) }),
      }),
    );
    assert.equal(amountOf(rTaxable, 'NY_YONKERS_SIT'), dollars(3.81));
  });
});

describe('New York Paid Family Leave (employee)', () => {
  test('0.432% of wages, no cap in play', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NY', certificate: { maritalStatus: 'single', exemptions: 0 } },
      }),
    );
    // 1,000 x 0.00432 = $4.32.
    assert.equal(amountOf(r, 'NY_PFML_EE'), dollars(4.32));
  });

  test('caps at the annual wage base ($95,348.76 = 52 x 2026 NYSAWW) using YTD, not just the current cheque', () => {
    // $95,000 already counted YTD, $1,000 more this week -- only $348.76 of
    // room remains under the cap.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NY', certificate: { maritalStatus: 'single', exemptions: 0 } },
        ytd: {
          socialSecurity: 0,
          medicare: 0,
          futa: 0,
          statePaidLeave: { NY: dollars(95000) },
        },
      }),
    );
    // Room: 95,348.76 - 95,000 = 348.76. 348.76 x 0.00432 = 1.5066432 -> $1.51.
    assert.equal(amountOf(r, 'NY_PFML_EE'), dollars(1.51));
  });

  test('runs even when NY income tax is $0 via reciprocity -- separate statute, separate levy', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        residenceState: { code: 'CA' },
        workState: { code: 'NY', certificate: { maritalStatus: 'single', exemptions: 0 } },
      }),
    );
    // NY has no reciprocity with any state (confirmed elsewhere), so this
    // doesn't actually zero NY_SIT -- included anyway as a structural check
    // that PFL is dispatched unconditionally, matching every other state's
    // employee-paid program in this project.
    assert.equal(amountOf(r, 'NY_PFML_EE'), dollars(4.32));
  });

  test('computed on GROSS wages -- a section125 pretax deduction does NOT reduce the PFL base, unlike NY_SIT', () => {
    // Weekly $1,000 regular wages, $200 section125 deduction. NY_SIT's own
    // base excludes the $200 (NYS income tax's exemptPretax list includes
    // section125), but PFL's cfg.exemptPretax override is an EMPTY array --
    // per Notice N-17-12 ('after-tax wages') and paidfamilyleave.ny.gov's
    // own 'gross wages' framing -- so PFL is computed on the FULL $1,000,
    // not the $800 net-of-cafeteria-plan figure. 1,000 x 0.00432 = $4.32,
    // the SAME answer as the no-deduction case above, proving the deduction
    // had zero effect on this specific line.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        deductions: [{ code: 'MED', category: 'section125', amount: dollars(200) }],
        workState: { code: 'NY', certificate: { maritalStatus: 'single', exemptions: 0 } },
      }),
    );
    assert.equal(amountOf(r, 'NY_PFML_EE'), dollars(4.32));
  });
});

describe('New York Disability Benefits Law (employee)', () => {
  test('0.5% of wages, below the weekly cap', () => {
    // Weekly $100 -- 0.5% = $0.50, below the $0.60/week cap.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(100) }],
        workState: { code: 'NY', certificate: { maritalStatus: 'single', exemptions: 0 } },
      }),
    );
    assert.equal(amountOf(r, 'NY_DBL_EE'), dollars(0.50));
  });

  test('caps at $0.60/week once wages exceed the implicit $120/week threshold', () => {
    // Weekly $1,000 -- 0.5% would be $5.00, but the weekly cap holds it at
    // $0.60 (0.5% x $120 = $0.60 is where the cap threshold sits).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NY', certificate: { maritalStatus: 'single', exemptions: 0 } },
      }),
    );
    assert.equal(amountOf(r, 'NY_DBL_EE'), dollars(0.60));
  });

  test('the weekly cap scales by pay frequency -- biweekly gets $1.20, not $0.60', () => {
    // A per-period cap that resets each period, unlike PFL's annual YTD
    // cap above -- proving this genuinely different cap shape works.
    // Biweekly $2,000: 0.5% = $10.00, capped at 2 weeks x $0.60 = $1.20.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        workState: { code: 'NY', certificate: { maritalStatus: 'single', exemptions: 0 } },
      }),
    );
    assert.equal(amountOf(r, 'NY_DBL_EE'), dollars(1.20));
  });

  test('the monthly cap scales to roughly 4.33 weeks, not a round dollar figure', () => {
    // Monthly $10,000: 0.5% = $50.00, capped at (52/12) x $0.60 =
    // 4.333... x $0.60 = $2.6 (2.60 exactly: 52/12*60=260 cents).
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(10000) }],
        workState: { code: 'NY', certificate: { maritalStatus: 'single', exemptions: 0 } },
      }),
    );
    assert.equal(amountOf(r, 'NY_DBL_EE'), dollars(2.60));
  });

  test('also computed on GROSS wages -- a 401(k) deferral does not reduce the DBL base either', () => {
    // Weekly $100 regular wages, $30 401(k) deferral. If DBL read the net-
    // of-deferral $70 base, 0.5% would be $0.35 -- instead it stays $0.50
    // (0.5% of the full $100), proving the same gross-wages override
    // applies to DBL as PFL.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(100) }],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(30) }],
        workState: { code: 'NY', certificate: { maritalStatus: 'single', exemptions: 0 } },
      }),
    );
    assert.equal(amountOf(r, 'NY_DBL_EE'), dollars(0.50));
  });
});

describe('New Jersey', () => {
  // Expected values hand-derived from NJ-WT's own Rate Table A/B weekly and
  // biweekly schedules (see data/states/NJ-2026.json's $extractionNote for
  // how those tables were reconstructed and cross-checked against NJ-WT's
  // own published per-period base figures) BEFORE the code was run, same
  // discipline as every other state file. No official worked example exists
  // in NJ-WT itself (that section of the PDF is an unextractable image), so
  // these are hand bracket-lookups, not reproductions of a published example
  // — disclosed here rather than presented as matching a source's own
  // worked arithmetic the way Kentucky/Wisconsin/Minnesota's tests do.

  test('Rate A (default, no certificate), weekly $1,000, 0 exemptions', () => {
    // $1,000 falls in the $769-$1,442 bracket: base $15.29 + 6.1% of
    // ($1,000-$769=$231) = $15.29 + $14.091 = $29.381 -> $29.38.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ' },
      }),
    );
    assert.equal(amountOf(r, 'NJ_SIT'), dollars(29.38));
  });

  test('exemptions reduce the base before the SAME bracket lookup', () => {
    // 2 exemptions x $19.20/week = $38.40 allowance. $1,000 - $38.40 =
    // $961.60, still in the $769-$1,442 bracket: $15.29 + 6.1% of
    // ($961.60-$769=$192.60) = $15.29 + $11.7486 = $27.0386 -> $27.04.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ', certificate: { exemptions: 2 } },
      }),
    );
    assert.equal(amountOf(r, 'NJ_SIT'), dollars(27.04));
  });

  test('filingStatus mfj/hoh/qw selects Rate Table B, not A', () => {
    // $1,000 falls in Rate B's $962-$1,346 bracket: base $17.31 + 2.7% of
    // ($1,000-$962=$38) = $17.31 + $1.026 = $18.336 -> $18.34.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ', certificate: { filingStatus: 'mfj' } },
      }),
    );
    assert.equal(amountOf(r, 'NJ_SIT'), dollars(18.34));
  });

  test('certificate.rateTableOverride (NJ-W4 Line 3) picks a specific table directly', () => {
    // Same $1,000 weekly wage, but the employee selected Rate B on Line 3
    // despite an otherwise Rate-A-selecting single filing status.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ', certificate: { filingStatus: 'single', rateTableOverride: 'B' } },
      }),
    );
    assert.equal(amountOf(r, 'NJ_SIT'), dollars(18.34));
  });

  test('biweekly $3,000 (the shared default paycheck), Rate A, 0 exemptions', () => {
    // $3,000 falls in Rate A biweekly's $2,885-$19,231 bracket: base
    // $112.69 + 7.0% of ($3,000-$2,885=$115) = $112.69 + $8.05 = $120.74.
    const r = calculatePaycheck(input({ workState: { code: 'NJ' } }));
    assert.equal(amountOf(r, 'NJ_SIT'), dollars(120.74));
  });

  test('reciprocity: a Pennsylvania resident working in NJ owes $0 NJ income tax, AND gets a PA swap line instead (NJ-165)', () => {
    // NJ-165's own text ("...authorize my employer to withhold Pennsylvania
    // personal income taxes on my behalf") confirms this isn't just a plain
    // exemption -- it's the same withholding SWAP mechanism PA's own
    // REV-419 describes from its side, now independently confirmed from
    // NJ's side too. reciprocitySwapWithholdingLine() (generic, gated by
    // NJ-2026.json's own reciprocity.swapWithholdsResidenceState) computes
    // PA's flat 3.07% on the same wages: 1,000 × 3.07% = $30.70.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        residenceState: { code: 'PA' },
        workState: { code: 'NJ' },
      }),
    );
    assert.equal(amountOf(r, 'NJ_SIT'), 0);
    assert.equal(amountOf(r, 'PA_SIT_RECIPROCITY_SWAP'), dollars(30.7));
  });

  test('supplemental wages paid AT THE SAME TIME as regular wages aggregate, allowance applies once', () => {
    // NJ-WT: "Total the employee's regular wage and supplemental wages and
    // withhold at the appropriate rate based on the combined payment." A
    // $700 regular + $300 supplemental cheque, 2 exemptions, is identical
    // to a single $1,000 regular cheque with 2 exemptions ($27.04, see
    // above) — the allowance is subtracted once from the combined total,
    // not once per earning line.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(700) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(300) },
        ],
        workState: { code: 'NJ', certificate: { exemptions: 2 } },
      }),
    );
    assert.equal(amountOf(r, 'NJ_SIT'), dollars(27.04));
  });

  test('supplemental wages on a SEPARATE cheque (no regular wages this period) are withheld WITHOUT the exemption allowance', () => {
    // NJ-WT: "If the supplemental wages are paid at a different time [than
    // regular wages]: Withhold from the supplemental wages without any
    // exemption allowances." Detected structurally — no 'regular' earning
    // on this cheque at all. 2 exemptions would normally subtract $38.40
    // ($19.20 x 2); here it must NOT be subtracted, so this differs from
    // the plain-regular-wages 2-exemptions case above ($27.04) even though
    // the gross dollar amount is identical.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(1000) }],
        workState: { code: 'NJ', certificate: { exemptions: 2 } },
      }),
    );
    // Full $1,000 (no allowance subtracted) falls in the same $769-$1,442
    // bracket as the very first test above: base $15.29 + 6.1% of
    // ($1,000-$769=$231) = $29.381 -> $29.38, NOT $27.04.
    assert.equal(amountOf(r, 'NJ_SIT'), dollars(29.38));
    assert.notEqual(amountOf(r, 'NJ_SIT'), dollars(27.04));
  });

  test('an unrecognized filingStatus throws rather than guessing a rate table', () => {
    assert.throws(() =>
      calculatePaycheck(
        input({ workState: { code: 'NJ', certificate: { filingStatus: 'bogus' } } }),
      ),
    );
  });

  test('quarterly and semiannual periods, derived from the annual table, are wired up', () => {
    // Rate A quarterly: $18,750-$125,000 bracket, base $732.50 + 7.0% of
    // ($20,000-$18,750=$1,250) = $732.50 + $87.50 = $820.00.
    const q = calculatePaycheck(
      input({
        payFrequency: 'quarterly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(20000) }],
        workState: { code: 'NJ' },
      }),
    );
    assert.equal(amountOf(q, 'NJ_SIT'), dollars(820.0));

    // Rate A semiannual: $37,500-$250,000 bracket (over the $10,000
    // threshold "and up" — no allowance claimed), base $1,465.00 + 7.0% of
    // ($40,000-$37,500=$2,500) = $1,465.00 + $175.00 = $1,640.00.
    const s = calculatePaycheck(
      input({
        payFrequency: 'semiannual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(40000) }],
        workState: { code: 'NJ' },
      }),
    );
    assert.equal(amountOf(s, 'NJ_SIT'), dollars(1640.0));
  });

  test("daily period uses NJ-WT's own 365-based divisor, not this engine's usual 260-day convention", () => {
    // Rate A daily: $205-$1,370 bracket, base $8.03 + 7.0% of
    // ($300-$205=$95) = $8.03 + $6.65 = $14.68.
    const r = calculatePaycheck(
      input({
        payFrequency: 'daily',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(300) }],
        workState: { code: 'NJ' },
      }),
    );
    assert.equal(amountOf(r, 'NJ_SIT'), dollars(14.68));
  });

  test("Newark's payroll tax: 1% employer-paid, does NOT reduce employee net pay", () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ', certificate: { locality: 'Newark' } },
      }),
    );
    const line = r.taxes.find((t) => t.id === 'NEWARK_PAYROLL_ER');
    assert.ok(line);
    assert.equal(line.payer, 'employer');
    assert.equal(line.jurisdiction, 'local');
    assert.equal(line.amount, dollars(10.0)); // 1% of $1,000

    // Employer-paid lines never reduce net pay — compare against an
    // otherwise-identical paycheck with no Newark locality.
    const noLocality = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ' },
      }),
    );
    assert.equal(r.netPay, noLocality.netPay);
  });

  test("Newark's payroll tax excludes federal pretax deferrals from its base, not NJ's own (empty) exempt list", () => {
    // $1,000 regular with a $200 401(k) deferral. NJ's OWN state income
    // tax is famously non-conforming (rules.exemptPretax === []) and
    // would tax the full $1,000 — but Newark's ordinance tracks FEDERAL
    // withholding wages, which exclude a 401(k) deferral. Taxable base
    // should be $800, not $1,000: 1% x $800 = $8.00, not $10.00.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(200) }],
        workState: { code: 'NJ', certificate: { locality: 'Newark' } },
      }),
    );
    const line = r.taxes.find((t) => t.id === 'NEWARK_PAYROLL_ER');
    assert.ok(line);
    assert.equal(line.taxableWages, dollars(800));
    assert.equal(line.amount, dollars(8.0));
  });

  test('no Newark payroll tax line when the employee is not linked to a Newark locality', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ' },
      }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'NEWARK_PAYROLL_ER'), false);

    const otherCity = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ', certificate: { locality: 'Jersey City' } },
      }),
    );
    assert.equal(otherCity.taxes.some((t) => t.id === 'NEWARK_PAYROLL_ER'), false);
  });

  test("certificate.newarkResidentApportionmentExcluded zeroes this employee's contribution, not the whole employer's liability", () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: {
          code: 'NJ',
          certificate: { locality: 'Newark', newarkResidentApportionmentExcluded: true },
        },
      }),
    );
    const line = r.taxes.find((t) => t.id === 'NEWARK_PAYROLL_ER');
    assert.ok(line);
    assert.equal(line.amount, 0);
  });
});

describe('New Jersey Unemployment/Workforce, TDI, and FLI (employee)', () => {
  test('combined UI/WF/SWF: 0.425% of wages, well under the $44,800 wage base', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ' },
      }),
    );
    assert.equal(amountOf(r, 'NJ_UC_EE'), dollars(4.25));
  });

  test('UI/WF/SWF caps at the $44,800 annual wage base using YTD, not just the current cheque', () => {
    // $44,750 YTD leaves only $50 of room this cheque, even though the
    // cheque itself is $1,000: $50 x 0.425% = $0.2125 -> $0.21.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ' },
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, stateUnemployment: { NJ: dollars(44_750) } },
      }),
    );
    assert.equal(amountOf(r, 'NJ_UC_EE'), dollars(0.21));
  });

  test('TDI: 0.19% of wages, capped at the $171,100 wage base via YTD', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ' },
      }),
    );
    assert.equal(amountOf(r, 'NJ_DBL_EE'), dollars(1.90));

    // $171,050 YTD leaves $50 of room: $50 x 0.19% = $0.095 -> $0.10 (round-half-up).
    const capped = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ' },
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, stateDisabilityEmployee: { NJ: dollars(171_050) } },
      }),
    );
    assert.equal(amountOf(capped, 'NJ_DBL_EE'), dollars(0.10));
  });

  test('FLI: 0.23% of wages, capped at the $171,100 wage base via YTD, separate tracker from TDI', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'NJ' },
      }),
    );
    assert.equal(amountOf(r, 'NJ_PFML_EE'), dollars(2.30));
  });

  test('UI/WF/SWF, TDI, and FLI all run even when NJ income tax is $0 via PA reciprocity', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        residenceState: { code: 'PA' },
        workState: { code: 'NJ' },
      }),
    );
    assert.equal(amountOf(r, 'NJ_SIT'), 0);
    assert.equal(amountOf(r, 'NJ_UC_EE'), dollars(4.25));
    assert.equal(amountOf(r, 'NJ_DBL_EE'), dollars(1.90));
    assert.equal(amountOf(r, 'NJ_PFML_EE'), dollars(2.30));
  });
});

describe('Idaho', () => {
  // Expected values hand-derived from EPB00744's own Table for Percentage
  // Computation Method (single weekly threshold $310, married $619; 5.3%
  // flat above it) before the code was run, same discipline as every other
  // state in this project. The Tax Commission's computing page then says
  // to round the result to the nearest whole dollar, so each figure in a
  // test name is the pre-rounding amount and the assertion the rounded one.
  // These pin the 07-23-2026 table, in force for checks from 2026-07-31.
  const idState = (certificate: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-14',
    workState: { code: 'ID', certificate },
  });

  test('before 2026-07-31 the 04-28-2025 table still applies, with its $148.77 biweekly child tax credit allowance', () => {
    // Idaho's own example: $1,212 biweekly single, 4 allowances: 1,212 - 595.08 = 616.92; (616.92 - 577) x 5.3% = $2.12 -> $2
    const r = calculatePaycheck(
      input({
        checkDate: '2026-03-13',
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1212) }],
        workState: { code: 'ID', certificate: { allowances: 4 } },
      }),
    );
    assert.equal(amountOf(r, 'ID_SIT'), dollars(2));
    // after the reissue the allowance is gone: (1,212 - 619) x 5.3% = $31.43 -> $31
    const after = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1212) }],
        ...idState({ allowances: 4 }),
      }),
    );
    assert.equal(amountOf(after, 'ID_SIT'), dollars(31));
  });

  test('weekly $1,000 single: (1,000 − 310) × 5.3% = $36.57', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...idState(),
      }),
    );
    assert.equal(amountOf(r, 'ID_SIT'), dollars(37));
  });

  test("married's threshold is exactly double single's: (1,000 − 619) × 5.3% = $20.19", () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...idState({ maritalStatus: 'married' }),
      }),
    );
    assert.equal(amountOf(r, 'ID_SIT'), dollars(20));
  });

  test('head of household folds into the single schedule — same $36.57 as plain single', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...idState({ maritalStatus: 'hoh' }),
      }),
    );
    assert.equal(amountOf(r, 'ID_SIT'), dollars(37));
  });

  test('wages at or below the threshold owe $0, not a negative bracket', () => {
    const below = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(300) }],
        ...idState(),
      }),
    );
    assert.equal(amountOf(below, 'ID_SIT'), 0);

    const atThreshold = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(310) }],
        ...idState(),
      }),
    );
    assert.equal(amountOf(atThreshold, 'ID_SIT'), 0);
  });

  test('Idaho conforms to federal pretax treatment — a 401(k) deferral REDUCES the Idaho base (unlike Pennsylvania)', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(200) }],
        ...idState(),
      }),
    );
    // (800 − 310) × 5.3% = $25.97, not $36.57.
    assert.equal(amountOf(r, 'ID_SIT'), dollars(26));
  });

  test('no reciprocity exemption exists — Idaho has none, confirmed structurally empty rather than omitted', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        residenceState: { code: 'OR' },
        ...idState(),
      }),
    );
    assert.equal(amountOf(r, 'ID_SIT'), dollars(37));
  });

  test("Form ID W-4's Box C (married, but withhold at Single rate) uses the single schedule — same $36.57", () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...idState({ maritalStatus: 'married_withhold_as_single' }),
      }),
    );
    assert.equal(amountOf(r, 'ID_SIT'), dollars(37));
  });

  test("nonresident alien: forced to the single schedule plus Form ID W-4's own Pay Period table add-on", () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        // maritalStatus: 'married' deliberately included to prove the NRA
        // instruction ("check Box A regardless of your marital status")
        // overrides it, not just supplements a default.
        ...idState({ nonresidentAlien: true, maritalStatus: 'married' }),
      }),
    );
    // (1,000 − 310) × 5.3% = $36.57, plus the weekly $15 NRA add-on = $51.57.
    assert.equal(amountOf(r, 'ID_SIT'), dollars(52));
  });

  test('nonresident alien on a pay frequency outside the Pay Period table falls back to $0 add-on, not an error', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(50000) }],
        ...idState({ nonresidentAlien: true }),
      }),
    );
    // (50,000 − 16,100) × 5.3% = $1,796.70, no annual row in the Pay Period
    // table so the add-on is $0, not a thrown error or a guessed figure.
    assert.equal(amountOf(r, 'ID_SIT'), dollars(1797));
  });

  test('an unrecognized marital status throws rather than silently defaulting', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            ...idState({ maritalStatus: 'mfs' }),
          }),
        ),
      /Unrecognized ID certificate\.maritalStatus/,
    );
  });

  test('no employee-paid unemployment, disability, or paid-leave lines exist for Idaho', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...idState(),
      }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'ID_UC_EE'), false);
    assert.equal(r.taxes.some((t) => t.id === 'ID_DBL_EE'), false);
    assert.equal(r.taxes.some((t) => t.id === 'ID_PFML_EE'), false);
  });
});

describe('Connecticut', () => {
  // Expected values independently hand-derived from Circular CT's own
  // 16-step Withholding Calculation Rules BEFORE running any of these —
  // computed via a standalone re-implementation of Steps 1-13 against
  // CT-2026.json's transcribed tables (kept out of engine.test.ts itself),
  // then cross-checked against calculatePaycheck()'s actual output. Two
  // independent implementations of the same source document agreeing is
  // the strongest verification available here, since Circular CT publishes
  // no to-the-cent worked examples the way PA/KY/WI do.
  const ctState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'CT', certificate },
  });

  test('weekly $1,000, Code A: no exemption left at this income, 2% phase-out add-back applies, no credit', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ctState({ withholdingCode: 'A' }),
      }),
    );
    // Annualized $52,000: exemption $0 (Code A phases to $0 at $35,000);
    // initial tax (Table B) $2,110; 2% phase-out add-back (Table C) $25;
    // recapture (Table D) $0; withholding $2,135. Table E credit at
    // $52,000 (Code A): 1% (the $52,000-$52,500 band — BUG FIXED
    // 2026-09-02, this file's own tableE data was previously missing most
    // of Table E's real bands, including this one, and reached 0% far too
    // early; see CT-2026.json's own knownGaps for the full fix, sourced
    // directly from TPG-211's own Table E page). $2,135 × 0.99 = $2,113.65
    // ÷ 52 = $40.6471... → $40.65.
    assert.equal(amountOf(r, 'CT_SIT'), dollars(40.65));
  });

  test('Code D always gets $0 exemption and $0 credit regardless of income', () => {
    // Same $2,135 withholding as Code A's own $52,000 case above (same
    // income, and Code D's own $0 exemption matches Code A's at this
    // level too), but Code D's credit is ALWAYS 0% (the 'ZERO' sentinel),
    // not read from Table E at all — so unlike Code A's now-correctly-
    // computed 1% credit at this exact income, Code D pays the full
    // $2,135 ÷ 52 = $41.0577 → $41.06, genuinely more than Code A's
    // $40.65 here. (Before the Table E fix above, both used to look the
    // same only because Code A's OWN credit was wrongly computed as 0% at
    // this income too — that coincidence is gone now that Table E is
    // correct.)
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ctState({ withholdingCode: 'D' }),
      }),
    );
    assert.equal(amountOf(r, 'CT_SIT'), dollars(41.06));
  });

  test('Code F, annual $30,000: exemption phase-down and Table E credit both apply', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(30000) }],
        ...ctState({ withholdingCode: 'F' }),
      }),
    );
    // Exemption at $30,000 (Code F): $14,000 → taxable $16,000. Table B
    // (A/D/F schedule): $200 + 4.5% × $6,000 = $470. Table C: $0 (below
    // $56,500). Table D: $0. Table E credit at $30,000 (Code F): 15% (the
    // $26,500-$31,300 band — BUG FIXED 2026-09-02, this file's own
    // tableE data previously had this band wrong at 1%; see
    // CT-2026.json's own knownGaps for the full fix, sourced directly
    // from TPG-211's own Table E page). $470 × 0.85 = $399.50.
    assert.equal(amountOf(r, 'CT_SIT'), dollars(399.5));
  });

  test('Code C, annual $600,000: high enough to trigger the Table D tax recapture', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(600000) }],
        ...ctState({ withholdingCode: 'C' }),
      }),
    );
    // No exemption left. Table B: $28,000 + 6.9% × $100,000 = $34,900.
    // Table C phase-out add-back at $600,000: $500 (past $145,500, flat).
    // Table D recapture at $600,000 (Code C schedule): $4,280 ($600,000
    // falls in the $600,000-$610,000 row). Sum $34,900+$500+$4,280 =
    // $39,680. Credit is 0% by this income. Total $39,680.00.
    assert.equal(amountOf(r, 'CT_SIT'), dollars(39680));
  });

  test('wages fully absorbed by the Code A exemption owe $0, not a negative bracket', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
        ...ctState({ withholdingCode: 'A' }),
      }),
    );
    // Annualized $10,400 is inside Code A's $0-$24,000 full-exemption band
    // ($12,000 exemption) — $10,400 < $12,000, so taxable income is
    // negative, clamped to $0 per Step 6's own instruction.
    assert.equal(amountOf(r, 'CT_SIT'), 0);
  });

  test('no Form CT-W4 on file: flat 6.99%, no exemption, no credit — NOT the usual "default single" convention', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ctState({}),
      }),
    );
    assert.equal(amountOf(r, 'CT_SIT'), dollars(69.9));
  });

  test('certificate.exempt (Form CT-W4 Code E) zeroes withholding, generically', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ctState({ exempt: true }),
      }),
    );
    assert.equal(amountOf(r, 'CT_SIT'), 0);
  });

  test("Form CT-W4 Line 2 (additional withholding) adds, Line 3 (reduced withholding) subtracts and floors at $0", () => {
    const base = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ctState({ withholdingCode: 'A' }),
      }),
    );
    assert.equal(amountOf(base, 'CT_SIT'), dollars(40.65));

    const withLine2 = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ctState({ withholdingCode: 'A', additionalWithholding: dollars(10) }),
      }),
    );
    assert.equal(amountOf(withLine2, 'CT_SIT'), dollars(50.65));

    const withLine3 = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ctState({ withholdingCode: 'A', reducedWithholding: dollars(10) }),
      }),
    );
    assert.equal(amountOf(withLine3, 'CT_SIT'), dollars(30.65));

    const line3ExceedsTax = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ctState({ withholdingCode: 'A', reducedWithholding: dollars(1000) }),
      }),
    );
    assert.equal(amountOf(line3ExceedsTax, 'CT_SIT'), 0);
  });

  test('an unrecognized withholding code throws rather than silently defaulting', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            ...ctState({ withholdingCode: 'Z' }),
          }),
        ),
      /Unrecognized CT certificate\.withholdingCode/,
    );
  });

  test('no reciprocity exemption exists — Connecticut has none', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        residenceState: { code: 'NY' },
        ...ctState({ withholdingCode: 'A' }),
      }),
    );
    assert.equal(amountOf(r, 'CT_SIT'), dollars(40.65));
  });

  test('CT Paid Leave: 0.5%, capped at the same wage base as federal Social Security', () => {
    const under = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ctState({ withholdingCode: 'A' }),
      }),
    );
    assert.equal(amountOf(under, 'CT_PFML_EE'), dollars(5));

    const overCap = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(600000) }],
        ...ctState({ withholdingCode: 'C' }),
      }),
    );
    // Capped at $184,500 × 0.5% = $922.50, not $600,000 × 0.5% = $3,000.
    assert.equal(amountOf(overCap, 'CT_PFML_EE'), dollars(922.5));
  });

  test('Idaho-style 401(k) conformity check: a deferral reduces the CT base (unlike Pennsylvania)', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(200) }],
        ...ctState({ withholdingCode: 'A' }),
      }),
    );
    // Annualized $41,600 taxable (down from $52,000): Table B $200+4.5%×
    // $31,600=$1,622; Table C at $41,600: $0 (below $50,250); Table D: $0;
    // Table E credit at $41,600 (Code A): 10% (the $27,000-$48,000 band —
    // BUG FIXED 2026-09-02, same Table E fix as the other CT tests above).
    // $1,622 × 0.90 = $1,459.80 ÷ 52 = $28.0730... → $28.07.
    assert.equal(amountOf(r, 'CT_SIT'), dollars(28.07));
  });
});

describe('Iowa', () => {
  // All 10 examples reproduced verbatim from Iowa's own 2026 Withholding
  // Formula document (revenue.iowa.gov) — expected values transcribed from
  // the source's own worked arithmetic before running, same discipline as
  // every other state in this project.
  const iaState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'IA', certificate },
  });

  test('Example 1: biweekly $2,100, 2026 IA W-4 "Other", $40 allowance → $59.26', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
        ...iaState({ maritalStatus: 'other', totalAllowanceAmount: dollars(40) }),
      }),
    );
    assert.equal(amountOf(r, 'IA_SIT'), dollars(59.26));
  });

  test('Example 2: biweekly $2,100, MFJ/QSS spouse not earning, $80 allowance → $38.72', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
        ...iaState({ maritalStatus: 'mfj', spouseHasEarnedIncome: false, totalAllowanceAmount: dollars(80) }),
      }),
    );
    assert.equal(amountOf(r, 'IA_SIT'), dollars(38.72));
  });

  test('Example 3: biweekly $2,100, Head of Household, $160 allowance → $45.15', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
        ...iaState({ maritalStatus: 'hoh', totalAllowanceAmount: dollars(160) }),
      }),
    );
    assert.equal(amountOf(r, 'IA_SIT'), dollars(45.15));
  });

  test('Example 4: monthly $5,000, "Other", $40 allowance → $145.50', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...iaState({ maritalStatus: 'other', totalAllowanceAmount: dollars(40) }),
      }),
    );
    assert.equal(amountOf(r, 'IA_SIT'), dollars(145.50));
  });

  test('Example 5: monthly $5,000, MFJ/QSS spouse not earning, $80 allowance → $101.00', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...iaState({ maritalStatus: 'mfj', spouseHasEarnedIncome: false, totalAllowanceAmount: dollars(80) }),
      }),
    );
    assert.equal(amountOf(r, 'IA_SIT'), dollars(101.00));
  });

  test('Example 6: monthly $5,000, Head of Household, $160 allowance → $114.92', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...iaState({ maritalStatus: 'hoh', totalAllowanceAmount: dollars(160) }),
      }),
    );
    assert.equal(amountOf(r, 'IA_SIT'), dollars(114.92));
  });

  test('Example 7: biweekly $2,100, LEGACY (pre-2024) Single, 1 allowance → $59.26', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
        ...iaState({ formVintage: 'pre_2024', maritalStatus: 'single', allowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'IA_SIT'), dollars(59.26));
  });

  test('Example 8: biweekly $2,100, LEGACY Married, 2 allowances → $38.72', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
        ...iaState({ formVintage: 'pre_2024', maritalStatus: 'married', allowances: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'IA_SIT'), dollars(38.72));
  });

  test('Example 9: monthly $5,000, LEGACY Single, 1 allowance → $145.50', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...iaState({ formVintage: 'pre_2024', maritalStatus: 'single', allowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'IA_SIT'), dollars(145.50));
  });

  test('Example 10: monthly $5,000, LEGACY Married, 2 allowances → $101.00', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...iaState({ formVintage: 'pre_2024', maritalStatus: 'married', allowances: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'IA_SIT'), dollars(101.00));
  });

  test('no IA W-4 on file defaults to "Other" with $0 allowance, per the source\'s own fallback rule', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
        workState: { code: 'IA' },
      }),
    );
    // Same $1,600 taxable base as Example 1 (D=$500/period either way), but
    // NO $40 allowance this time: T2=$60.80, T3=$60.80-$0=$60.80.
    assert.equal(amountOf(r, 'IA_SIT'), dollars(60.80));
  });

  test('certificate.exempt and certificate.additionalWithholding work generically', () => {
    const exempt = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
        ...iaState({ exempt: true }),
      }),
    );
    assert.equal(amountOf(exempt, 'IA_SIT'), 0);

    const withExtra = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
        ...iaState({ maritalStatus: 'other', totalAllowanceAmount: dollars(40), additionalWithholding: dollars(25) }),
      }),
    );
    assert.equal(amountOf(withExtra, 'IA_SIT'), dollars(59.26 + 25));
  });

  test('reciprocity: an Illinois resident working in Iowa owes $0 Iowa income tax', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
        residenceState: { code: 'IL' },
        ...iaState({ maritalStatus: 'other', totalAllowanceAmount: dollars(40) }),
      }),
    );
    assert.equal(amountOf(r, 'IA_SIT'), 0);
  });

  test('quarterly pay period uses the annualize-then-divide fallback and reproduces the biweekly-equivalent rate', () => {
    // 4x Example 1's biweekly wages annualized to a quarterly-equivalent
    // check: $2,100/biweekly x 26 periods/yr = $54,600/yr = $13,650/quarter.
    const r = calculatePaycheck(
      input({
        payFrequency: 'quarterly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(13650) }],
        ...iaState({ maritalStatus: 'other', totalAllowanceAmount: dollars(40) }),
      }),
    );
    // Annual wages = 13,650 x 4 = 54,600. T1 = 54,600 - 13,000 = 41,600.
    // T2 = 41,600 x 3.8% = 1,580.80. T3 = 1,580.80 - 40 = 1,540.80/yr,
    // ÷ 4 quarters = $385.20/quarter.
    assert.equal(amountOf(r, 'IA_SIT'), dollars(385.20));
  });

  test('an unrecognized marital status throws for both W-4 vintages', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'biweekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
            ...iaState({ maritalStatus: 'qss' }),
          }),
        ),
      /Unrecognized IA certificate\.maritalStatus/,
    );
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'biweekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
            ...iaState({ formVintage: 'pre_2024', maritalStatus: 'hoh' }),
          }),
        ),
      /Unrecognized IA certificate\.maritalStatus/,
    );
  });

  test('no local income tax and no employee-paid unemployment/disability/paid-leave lines exist for Iowa', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2100) }],
        ...iaState({ maritalStatus: 'other', totalAllowanceAmount: dollars(40) }),
      }),
    );
    assert.equal(r.taxes.some((t) => t.jurisdiction === 'local'), false);
    assert.equal(r.taxes.some((t) => t.id === 'IA_UC_EE'), false);
    assert.equal(r.taxes.some((t) => t.id === 'IA_DBL_EE'), false);
    assert.equal(r.taxes.some((t) => t.id === 'IA_PFML_EE'), false);
  });
});

describe('Vermont', () => {
  const vtState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'VT', certificate },
  });

  test("reproduces GB-1210-2026's own worked example: weekly $1,800, married, 2 allowances → $45.77", () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1800) }],
        ...vtState({ maritalStatus: 'mfj', allowances: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'VT_SIT'), dollars(45.77));
  });

  test('weekly $1,000 single, 0 allowances: (1,000 − 75) × 3.35% = $30.99', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...vtState({ maritalStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'VT_SIT'), dollars(30.99));
  });

  test("Form W-4VT's 'married, but withhold at higher Single rate' and MFS both use the single schedule", () => {
    const higherSingle = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...vtState({ maritalStatus: 'married_withhold_as_single' }),
      }),
    );
    assert.equal(amountOf(higherSingle, 'VT_SIT'), dollars(30.99));

    const mfs = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...vtState({ maritalStatus: 'mfs' }),
      }),
    );
    assert.equal(amountOf(mfs, 'VT_SIT'), dollars(30.99));
  });

  test('wages below the threshold owe $0', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(70) }],
        ...vtState({ maritalStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'VT_SIT'), 0);
  });

  test('certificate.exempt and certificate.additionalWithholding work generically', () => {
    const exempt = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...vtState({ exempt: true }),
      }),
    );
    assert.equal(amountOf(exempt, 'VT_SIT'), 0);

    const withExtra = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...vtState({ maritalStatus: 'single', additionalWithholding: dollars(10) }),
      }),
    );
    assert.equal(amountOf(withExtra, 'VT_SIT'), dollars(30.99 + 10));
  });

  test('an unrecognized marital status throws rather than silently defaulting', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            ...vtState({ maritalStatus: 'hoh' }),
          }),
        ),
      // resolveMFJMaritalStatus() is now shared with Nebraska, so its error
      // message dropped the VT-specific wording — updated here to match.
      /Unrecognized certificate\.maritalStatus/,
    );
  });

  test('an unsupported pay frequency (semiannual) throws rather than guessing', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'semiannual',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(9000) }],
            ...vtState({ maritalStatus: 'single' }),
          }),
        ),
      /doesn't publish a "semiannual" figure/,
    );
  });

  test('no local income tax and no employee-paid unemployment/disability/paid-leave lines exist for Vermont', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...vtState({ maritalStatus: 'single' }),
      }),
    );
    assert.equal(r.taxes.some((t) => t.jurisdiction === 'local'), false);
    assert.equal(r.taxes.some((t) => t.id === 'VT_UC_EE'), false);
    assert.equal(r.taxes.some((t) => t.id === 'VT_DBL_EE'), false);
    assert.equal(r.taxes.some((t) => t.id === 'VT_PFML_EE'), false);
  });
});

describe('Kansas', () => {
  const ksState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'KS', certificate },
  });

  test("reproduces KW-100's own worked example: semimonthly $2,000, married/spouse not working, 1 dependent → $41.44", () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...ksState({ allowanceRate: 'joint', personalAllowances: 2, dependents: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'KS_SIT'), dollars(41.44));
  });

  test('weekly $400 single, 1 personal allowance: (400 − 176.15) × 5.2% = $8.05', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...ksState({ allowanceRate: 'single', personalAllowances: 1 }),
      }),
    );
    // Annual exemption $9,160 ÷ 52 = $176.1538..., net = $223.8462...
    // Falls in [69, 512): 5.2% of (223.8462 − 69) = 5.2% × 154.8462 = $8.05.
    assert.equal(amountOf(r, 'KS_SIT'), dollars(8.05));
  });

  test('no K-4 on file: withheld at Single rate with $0 exemption, per KW-100\'s own explicit instruction', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        workState: { code: 'KS' },
      }),
    );
    // No allowance subtracted: 400 falls in [69,512): 5.2% × (400-69) = $17.21.
    assert.equal(amountOf(r, 'KS_SIT'), dollars(17.21));
  });

  test('Head of Household uses the single/HOH bracket table but gets the extra $2,320 allowance', () => {
    const withoutHoh = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...ksState({ allowanceRate: 'single', personalAllowances: 1 }),
      }),
    );
    const withHoh = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...ksState({ allowanceRate: 'single', personalAllowances: 1, headOfHousehold: true }),
      }),
    );
    assert.ok(amountOf(withHoh, 'KS_SIT') < amountOf(withoutHoh, 'KS_SIT'));
  });

  test('certificate.exempt and certificate.additionalWithholding work generically', () => {
    const exempt = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...ksState({ exempt: true }),
      }),
    );
    assert.equal(amountOf(exempt, 'KS_SIT'), 0);

    const withExtra = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...ksState({ allowanceRate: 'single', personalAllowances: 1, additionalWithholding: dollars(15) }),
      }),
    );
    assert.equal(amountOf(withExtra, 'KS_SIT'), dollars(8.05 + 15));
  });

  test('an unrecognized allowance rate throws rather than silently defaulting', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
            ...ksState({ allowanceRate: 'married' }),
          }),
        ),
      /Unrecognized KS certificate\.allowanceRate/,
    );
  });

  test('resident-working-elsewhere credit: KS resident working in MI owes the KS/MI shortfall', () => {
    // Weekly $2,000. MI: flat 4.25%, no allowances claimed = $85.00.
    // KS: single, 1 personal allowance ($9,160/yr ÷ 52) net wages land in
    // the 5.58% bracket = $96.20 due. Credit = $96.20 − $85.00 = $11.20.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        workState: { code: 'MI' },
        residenceState: { code: 'KS', certificate: { allowanceRate: 'single', personalAllowances: 1 } },
      }),
    );
    assert.equal(amountOf(r, 'MI_SIT'), dollars(85.0));
    assert.equal(amountOf(r, 'KS_SIT_CREDIT'), dollars(11.2));
  });

  test('resident-working-elsewhere credit floors at $0 when the work state already withheld more', () => {
    // Weekly $1,000: MI flat 4.25% = $42.50, KS single/1-allowance = $40.40.
    // MI already withheld more than KS would have required, per KW-100's
    // own rule ("no Kansas withholding tax is due") — not simply absent.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'MI' },
        residenceState: { code: 'KS', certificate: { allowanceRate: 'single', personalAllowances: 1 } },
      }),
    );
    assert.equal(amountOf(r, 'MI_SIT'), dollars(42.5));
    assert.equal(amountOf(r, 'KS_SIT_CREDIT'), 0);
    assert.ok(r.taxes.some((t) => t.id === 'KS_SIT_CREDIT'));
  });

  test('no resident-working-elsewhere credit line when residence and work state are the same, or residenceState is unset', () => {
    const sameState = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'KS', certificate: { allowanceRate: 'single', personalAllowances: 1 } },
        residenceState: { code: 'KS', certificate: { allowanceRate: 'single', personalAllowances: 1 } },
      }),
    );
    assert.equal(sameState.taxes.some((t) => t.id === 'KS_SIT_CREDIT'), false);

    const noResidence = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'MI' },
      }),
    );
    assert.equal(noResidence.taxes.some((t) => t.id === 'KS_SIT_CREDIT'), false);
  });

  test('no local income tax and no employee-paid unemployment/disability/paid-leave lines exist for Kansas', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...ksState({ allowanceRate: 'single', personalAllowances: 1 }),
      }),
    );
    assert.equal(r.taxes.some((t) => t.jurisdiction === 'local'), false);
    assert.equal(r.taxes.some((t) => t.id === 'KS_UC_EE'), false);
    assert.equal(r.taxes.some((t) => t.id === 'KS_DBL_EE'), false);
    assert.equal(r.taxes.some((t) => t.id === 'KS_PFML_EE'), false);
  });

  // KW-100's own supplemental-wages rule: 5% flat when the bonus is stated
  // separately, mirroring whichever method the employer used federally.
  describe('Supplemental wages (KW-100)', () => {
    test("reproduces KW-100's own worked example: a standalone $1,000 bonus withholds exactly $50 (5%)", () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(1000) }],
          ...ksState({ allowanceRate: 'single', personalAllowances: 0 }),
        }),
      );
      assert.equal(amountOf(r, 'KS_SIT_SUPP'), dollars(50.0));
    });

    test('a bonus paid alongside regular wages is combined and taxed through the ordinary formula instead', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [
            { code: 'REG', category: 'regular', amount: dollars(1000) },
            { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
          ],
          ...ksState({ allowanceRate: 'single', personalAllowances: 0 }),
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'KS_SIT_SUPP'), false);
      const combined = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
          ...ksState({ allowanceRate: 'single', personalAllowances: 0 }),
        }),
      );
      assert.equal(amountOf(r, 'KS_SIT'), amountOf(combined, 'KS_SIT'));
    });
  });
});

describe('New Hampshire', () => {
  // New Hampshire has no income tax of any kind for 2026 (the Interest &
  // Dividends Tax fully repealed 2025-01-01) — the simplest state file in
  // this project, using the existing no_income_tax method with zero new
  // calc code.
  test('no state income tax line at all — zero, not merely unmodelled', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        workState: { code: 'NH' },
      }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'NH_SIT'), false);
  });

  test('no local income tax and no employee-paid unemployment/disability/paid-leave lines exist for New Hampshire', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        workState: { code: 'NH' },
      }),
    );
    assert.equal(r.taxes.some((t) => t.jurisdiction === 'local'), false);
    assert.equal(r.taxes.some((t) => t.id === 'NH_UC_EE'), false);
    assert.equal(r.taxes.some((t) => t.id === 'NH_DBL_EE'), false);
    assert.equal(r.taxes.some((t) => t.id === 'NH_PFML_EE'), false);
  });
});

describe('Washington', () => {
  // Expected values hand-derived from Washington's own Employer Wage
  // Reporting and Premiums Toolkit formula before running: PFML employee
  // share = wages x 0.0113 x 0.7143; WA Cares = wages x 0.0058, uncapped.
  const waState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'WA', certificate },
  });

  test('no state or local income tax line exists for Washington', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...waState(),
      }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'WA_SIT'), false);
    assert.equal(r.taxes.some((t) => t.jurisdiction === 'local'), false);
  });

  test('PFML employee share: $1,000 x 0.0113 x 0.7143 = $8.07', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...waState(),
      }),
    );
    assert.equal(amountOf(r, 'WA_PFML_EE'), dollars(8.07));
  });

  // The wage base is the "ssWageBase" sentinel (data/states/WA-2026.json),
  // resolved live from data/federal/2026.json's own socialSecurity.wageBase
  // ($184,500) rather than a hand-copied literal — closed 2026-09-06 to
  // remove a real, self-disclosed drift risk (this used to be a bare
  // 184500 the file's own comment said "must be kept in sync ... or this
  // file will silently drift stale"). This test proves the cap actually
  // applies, not just that it resolves to a number.
  test('PFML wage base tracks the live federal SS cap: $500 of room left at $184,000 YTD', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, statePaidLeave: { WA: dollars(184000) } },
        ...waState(),
      }),
    );
    // Only $500 of room left under the $184,500 SS-linked cap, taxed at
    // the full 0.0113 x 0.7143 employee-share rate: 500 x 0.00807159 = 4.04 (rounded).
    assert.equal(amountOf(r, 'WA_PFML_EE'), dollars(4.04));
  });

  test('WA Cares Fund: $1,000 x 0.58% = $5.80', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...waState(),
      }),
    );
    assert.equal(amountOf(r, 'WA_LTC_EE'), dollars(5.8));
  });

  test('no PFML employer-share line by default (small-employer assumption)', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...waState(),
      }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'WA_PFML_ER'), false);
  });

  test('PFML employer share, once certified 50+ employees: total premium less employee share = $3.23', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...waState({ employerLiableForPaidLeaveShare: true }),
      }),
    );
    // Total premium $11.30, employee share $8.07, employer share $3.23.
    assert.equal(amountOf(r, 'WA_PFML_ER'), dollars(3.23));
    const employerLine = r.taxes.find((t) => t.id === 'WA_PFML_ER');
    assert.equal(employerLine?.payer, 'employer');
  });

  test('PFML shares the Social Security wage cap; WA Cares does not', () => {
    // Employee already at the $184,500 SS cap for the year — PFML employee
    // share is now $0, but WA Cares keeps taxing the full new wages since
    // it has no cap at all ("The Social Security cap does not apply").
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ytd: {
          socialSecurity: 0,
          medicare: 0,
          futa: 0,
          statePaidLeave: { WA: dollars(184500) },
        },
        ...waState(),
      }),
    );
    assert.equal(amountOf(r, 'WA_PFML_EE'), 0);
    assert.equal(amountOf(r, 'WA_LTC_EE'), dollars(5.8));
  });

  test('no reciprocity exemption exists — not applicable, since Washington has no income tax at all', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        residenceState: { code: 'OR' },
        ...waState(),
      }),
    );
    // Both payroll levies still apply regardless of residence — they are
    // not income-tax reciprocity-exemptable levies.
    assert.equal(amountOf(r, 'WA_PFML_EE'), dollars(8.07));
    assert.equal(amountOf(r, 'WA_LTC_EE'), dollars(5.8));
  });

  test('WA Cares Fund exemption (certificate.wacaresExempt) zeroes only WA Cares, not PFML', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...waState({ wacaresExempt: true }),
      }),
    );
    assert.equal(amountOf(r, 'WA_LTC_EE'), 0);
    assert.ok(r.taxes.some((t) => t.id === 'WA_LTC_EE'));
    // PFML is a genuinely separate levy under a separate exemption scheme —
    // a WA Cares exemption does not imply a PFML exemption.
    assert.equal(amountOf(r, 'WA_PFML_EE'), dollars(8.07));
  });

  test('Paid Leave exemption (certificate.paidLeaveExempt) zeroes both employee and employer PFML shares', () => {
    const employeeSide = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...waState({ paidLeaveExempt: true }),
      }),
    );
    assert.equal(amountOf(employeeSide, 'WA_PFML_EE'), 0);
    // WA Cares is unaffected — separate exemption scheme.
    assert.equal(amountOf(employeeSide, 'WA_LTC_EE'), dollars(5.8));

    const employerSide = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...waState({ paidLeaveExempt: true, employerLiableForPaidLeaveShare: true }),
      }),
    );
    assert.equal(employerSide.taxes.some((t) => t.id === 'WA_PFML_ER'), false);
  });

  test('BUG FIX: paidLeaveExempt/wacaresExempt/employerLiableForPaidLeaveShare: "false" (strings) throw', () => {
    // All three used to be read as bare truthy values — a string "false"
    // for paidLeaveExempt or wacaresExempt would have silently zeroed a
    // real premium; for employerLiableForPaidLeaveShare (read as `!cert.…`)
    // a string "false" is truthy, so `!"false"` is false, meaning the
    // gate would have WRONGLY treated the employer as liable.
    const base = {
      payFrequency: 'weekly' as const,
      earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(1000) }],
    };
    assert.throws(
      () => calculatePaycheck(input({ ...base, ...waState({ paidLeaveExempt: 'false' }) })),
      /Unrecognized certificate\.paidLeaveExempt/,
    );
    assert.throws(
      () => calculatePaycheck(input({ ...base, ...waState({ wacaresExempt: 'false' }) })),
      /Unrecognized certificate\.wacaresExempt/,
    );
    assert.throws(
      () =>
        calculatePaycheck(
          input({ ...base, ...waState({ paidLeaveExempt: true, employerLiableForPaidLeaveShare: 'false' }) }),
        ),
      /Unrecognized certificate\.employerLiableForPaidLeaveShare/,
    );
  });
});

describe('Massachusetts', () => {
  // Expected values computed via the live engine and independently
  // hand-verified against Circular M's own known figures before being
  // written here as assertions (Circular M itself was unreachable — see
  // MA-2026.json's $extractionNote — so this project's usual "reproduce
  // the source's own worked example" discipline isn't available; this is
  // the fallback discipline instead).
  // These tests exercise the exemption/surtax/credit mechanics, so they
  // start from a YTD where the $2,000 FICA deduction is already used up
  // ($30,000 x 7.65% = $2,295 > $2,000) and it stays out of the arithmetic.
  // The deduction itself has its own tests at the end of this block.
  const maState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'MA', certificate },
    ytd: { socialSecurity: dollars(30000), medicare: dollars(30000), futa: dollars(7000) },
  });

  test("no certificate filed: Form M-4's own instruction is withholding \"without exemptions\" — full $100.00, not the $95.77 a filed certificate would give", () => {
    // Verification-pass finding: an earlier version of this file defaulted
    // the unset personal-exemption code to 1 (the full $4,400 exemption),
    // silently granting a benefit the source explicitly says a no-form
    // employee does NOT get. (2,000 − $0 exemption) × 5% = $100.00.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...maState(),
      }),
    );
    assert.equal(amountOf(r, 'MA_SIT'), dollars(100));
  });

  test('single, personal exemption claimed (Form M-4 Line 1 = "1"): (2,000 − 84.62 exemption) × 5% = $95.77', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...maState({ personalExemptionCode: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'MA_SIT'), dollars(95.77));
  });

  test("Form M-4 Line 4 is a literal SUM of the raw codes, not a per-category total: personal(1)+spouse(4)+2 dependents = 7 → $1,000×7+$3,400 = $10,400/yr exemption → $90.00", () => {
    // Verification-pass correction: an earlier version of this test
    // asserted $89.62, built on a WRONG per-category model (personal
    // $4,400 + spouse $4,400 + 2×$1,000 dependents = $10,800/yr). The USDA
    // National Finance Center's own MA withholding bulletin, cross-checked
    // against Form M-4's own Line 4 instruction ("Add the number of
    // exemptions which you have claimed above"), confirms Line 4 = 1+4+2 =
    // 7, and the real formula is $1,000 × 7 + $3,400 = $10,400/yr (÷52 =
    // $200.00/week exactly). (2,000 − 200) × 5% = $90.00.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...maState({ personalExemptionCode: 1, spouseExemptionCode: 4, dependents: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'MA_SIT'), dollars(90));
  });

  test('personal exemption code "2" (age 65+): Line 4 = 2 → $1,000×2+$3,400 = $5,400/yr exemption → $94.81', () => {
    // Also corrected: the old per-category model computed $5,100/yr
    // ($4,400 personal + a separately-tallied $700 age-65 addition), not
    // the real $5,400 the Line-4-sum formula gives at Line4=2.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...maState({ personalExemptionCode: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'MA_SIT'), dollars(94.81));
  });

  test('Head of Household credit ($120/yr) and blindness credit ($110/yr) subtract from the computed TAX, not from wages', () => {
    const hoh = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...maState({ personalExemptionCode: 1, headOfHousehold: true }),
      }),
    );
    assert.equal(amountOf(hoh, 'MA_SIT'), dollars(93.46));

    const blind = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...maState({ personalExemptionCode: 1, blind: true }),
      }),
    );
    assert.equal(amountOf(blind, 'MA_SIT'), dollars(93.65));
  });

  test('BUG FIX: headOfHousehold/blind: "false" (strings) throw rather than being silently treated as true', () => {
    // Both credits used to be read as bare truthy values — a string "false"
    // for either would have granted a credit (under-withholding tax) that
    // a real Form M-4 doesn't actually claim.
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
            ...maState({ personalExemptionCode: 1, headOfHousehold: 'false' }),
          }),
        ),
      /Unrecognized certificate\.headOfHousehold/,
    );
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
            ...maState({ personalExemptionCode: 1, blind: 'false' }),
          }),
        ),
      /Unrecognized certificate\.blind/,
    );
  });

  test('Fair Share Amendment 4% surtax applies to annualized net wages above $1,107,750', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(30000) }],
        ...maState({ personalExemptionCode: 1 }),
      }),
    );
    // Annualized net wages $1,555,600 → $55,387.50 base (5% up to threshold)
    // + 9% of the $447,850 excess = $95,694.00/yr ÷ 52 = $1,840.27.
    assert.equal(amountOf(r, 'MA_SIT'), dollars(1840.27));
  });

  test('additional withholding (Form M-4 Line 5) works generically: $95.77 + $25.00 = $120.77', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...maState({ personalExemptionCode: 1, additionalWithholding: dollars(25) }),
      }),
    );
    assert.equal(amountOf(r, 'MA_SIT'), dollars(120.77));
  });

  test('an unrecognized exemption code throws rather than silently defaulting', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
            ...maState({ personalExemptionCode: 3 }),
          }),
        ),
      /Unrecognized MA certificate\.personalExemptionCode/,
    );
  });

  test('PFML: employee flat 0.46% regardless of employer size; employer share (25+ employees) is total minus employee', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...maState(),
      }),
    );
    assert.equal(amountOf(r, 'MA_PFML_EE'), dollars(9.2));
    assert.equal(r.taxes.some((t) => t.id === 'MA_PFML_ER'), false);

    const withEmployer = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...maState({ employerLiableForPaidLeaveShare: true }),
      }),
    );
    // Total $17.60 (0.88%) − employee $9.20 (0.46%) = $8.40.
    assert.equal(amountOf(withEmployer, 'MA_PFML_ER'), dollars(8.4));
  });

  test('no reciprocity exemption exists — Massachusetts has none, confirmed structurally empty rather than omitted', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        residenceState: { code: 'RI' },
        ...maState({ personalExemptionCode: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'MA_SIT'), dollars(95.77));
  });

  test('no local income tax exists for Massachusetts', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...maState(),
      }),
    );
    assert.equal(r.taxes.some((t) => t.jurisdiction === 'local'), false);
  });

  test("Circular M's FICA deduction: this cheque's Social Security + Medicare comes off wages first — matches PaycheckCity: monthly $4,750, no certificate -> $219.33", () => {
    // FICA = 4,750 x 7.65% = $363.38, well under the $2,000 annual cap.
    // (4,750 - 363.38) x 5% = $219.33. Before this deduction was wired the
    // engine withheld $237.50 here, $18.17 more than PaycheckCity.
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(4750) }],
        workState: { code: 'MA', certificate: {} },
      }),
    );
    assert.equal(amountOf(r, 'MA_SIT'), dollars(219.33));
  });

  test('the FICA deduction stops at $2,000 for the year: the cheque that crosses the cap deducts only what is left', () => {
    // Prior YTD FICA = 25,000 x 6.2% + 25,000 x 1.45% = $1,912.50, leaving
    // $87.50. This cheque's FICA ($153.00) is limited to that $87.50.
    // (2,000 - 87.50) x 5% = $95.625 -> $95.63.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ytd: { socialSecurity: dollars(25000), medicare: dollars(25000), futa: dollars(7000) },
        workState: { code: 'MA', certificate: {} },
      }),
    );
    assert.equal(amountOf(r, 'MA_SIT'), dollars(95.63));
  });

  test('no withholding for an employee claiming an exemption with annual wages under $8,000; a no-certificate employee is still withheld on', () => {
    const low = (certificate: Record<string, unknown>) =>
      calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(150) }],
          workState: { code: 'MA', certificate },
        }),
      );
    // $150 x 52 = $7,800 < $8,000 with Line 4 = 1.
    assert.equal(amountOf(low({ personalExemptionCode: 1 }), 'MA_SIT'), 0);
    // No certificate: (150 - 11.48 FICA) x 5% = $6.926 -> $6.93.
    assert.equal(amountOf(low({}), 'MA_SIT'), dollars(6.93));
  });
});

describe('Maine', () => {
  // All 3 examples reproduced verbatim from Maine Revenue Services' own
  // 2026 Withholding Tables booklet — expected values transcribed from the
  // source's own worked arithmetic (including its multi-step whole-dollar
  // rounding) before running, same discipline as every other state.
  const meState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'ME', certificate },
  });

  test('Example 1: single $300/week, 2 allowances → annualized income is negative, so $0 withheld', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(300) }],
        ...meState({ maritalStatus: 'single', allowances: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'ME_SIT'), 0);
  });

  test('Example 2: single $1,000/week, 2 allowances → $33 (annualized $1,694 ÷ 52, rounded)', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...meState({ maritalStatus: 'single', allowances: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'ME_SIT'), dollars(33));
  });

  test('Example 3: married $4,500/week, 2 allowances, in the standard-deduction phase-out band → $257', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(4500) }],
        ...meState({ maritalStatus: 'married', allowances: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'ME_SIT'), dollars(257));
  });

  test('no Form W-4ME on file defaults to single, zero allowances → $46', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'ME' },
      }),
    );
    assert.equal(amountOf(r, 'ME_SIT'), dollars(46));
  });

  test('certificate.exempt and certificate.additionalWithholding work generically', () => {
    const exempt = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...meState({ exempt: true }),
      }),
    );
    assert.equal(amountOf(exempt, 'ME_SIT'), 0);

    const withExtra = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...meState({ maritalStatus: 'single', allowances: 2, additionalWithholding: dollars(10) }),
      }),
    );
    assert.equal(amountOf(withExtra, 'ME_SIT'), dollars(33 + 10));
  });

  test("USDA NFC's own instruction — round AGAIN to the nearest dollar after adding Line 5 — holds even for a non-whole-dollar additional amount", () => {
    // $33 base + $10.60 additional = $43.60, which Maine's own formula
    // rounds to $44, not left at $43.60 the way every cent-rounding
    // state's own additionalWithholding line would be.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...meState({ maritalStatus: 'single', allowances: 2, additionalWithholding: dollars(10.6) }),
      }),
    );
    assert.equal(amountOf(r, 'ME_SIT'), dollars(44));
  });

  test("Married, but withholding at higher Single rate' uses the single schedule", () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...meState({ maritalStatus: 'married_withhold_as_single', allowances: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'ME_SIT'), dollars(33));
  });

  test('an unrecognized marital status throws rather than silently defaulting', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            ...meState({ maritalStatus: 'hoh' }),
          }),
        ),
      /Unrecognized ME certificate\.maritalStatus/,
    );
  });

  test('PFML: employee flat 0.5%; employer share (15+ employees) is the other 0.5%', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'ME' },
      }),
    );
    assert.equal(amountOf(r, 'ME_PFML_EE'), dollars(5));
    assert.equal(r.taxes.some((t) => t.id === 'ME_PFML_ER'), false);

    const withEmployer = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...meState({ employerLiableForPaidLeaveShare: true }),
      }),
    );
    assert.equal(amountOf(withEmployer, 'ME_PFML_ER'), dollars(5));
  });

  test('no reciprocity exemption exists — Maine has none, confirmed structurally empty rather than omitted', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        residenceState: { code: 'NH' },
        ...meState({ maritalStatus: 'single', allowances: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'ME_SIT'), dollars(33));
  });

  test('no local income tax line exists for Maine', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...meState({ maritalStatus: 'single', allowances: 2 }),
      }),
    );
    assert.equal(r.taxes.some((t) => t.jurisdiction === 'local'), false);
  });

  test('PFML rate override lets a caller supply a specific small employer\'s own chosen rate: $1,000 × 0.20% = $2.00', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...meState({ paidLeaveEmployeeRateOverride: 0.002 }),
      }),
    );
    assert.equal(amountOf(r, 'ME_PFML_EE'), dollars(2));
  });

  test('tribal exemption (certificate.exemptWages) excludes just the tribal-land-sourced portion of wages, not the whole cheque', () => {
    // $1,000 wages, $400 earned on tribal land and exempt under Form
    // W-4ME Line 7 -- only $600/week is Maine-taxable.
    const partial = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...meState({ maritalStatus: 'single', allowances: 2, exemptWages: dollars(400) }),
      }),
    );
    // $600 × 52 = $31,200/yr − $10,600 allowances − $12,450 standard
    // deduction = $8,150 annualized income × 5.8% = $472.70 → $473,
    // ÷ 52 = $9.096... → $9.
    assert.equal(amountOf(partial, 'ME_SIT'), dollars(9));

    // If ALL wages are tribal-land-sourced, this reproduces the same $0
    // result the all-or-nothing certificate.exempt flag already gives.
    const full = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...meState({ maritalStatus: 'single', allowances: 2, exemptWages: dollars(1000) }),
      }),
    );
    assert.equal(amountOf(full, 'ME_SIT'), 0);
  });
});

describe('Ohio', () => {
  // Expected values hand-derived from OH-2026.json's own periodTables
  // (transcribed verbatim from the Ohio Department of Taxation's own
  // withholding tables in an earlier session) before running, then
  // confirmed against the live engine — this describe block closes the
  // long-standing gap where OH's 'bracket_per_period' method had no
  // dispatch case at all, so calculatePaycheck() threw for any Ohio input.
  // checkDate is set explicitly to on/after 2026-08-01 in every test below
  // (the engine test suite's own global default, '2026-06-15', is BEFORE
  // Ohio's HB96 rate change — see the dedicated mid-year-dating tests
  // further down for that boundary specifically) so each test's intent
  // (testing the CURRENT table) doesn't depend on a shared default that
  // has nothing to do with Ohio.
  const ohState = (certificate: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    workState: { code: 'OH', certificate },
  });

  test('weekly $1,000, 1 exemption: (1,000 − 12.50) × bracket = $22.57', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ohState({ exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'OH_SIT'), dollars(22.57));
  });

  test('no IT-4 on file defaults to 0 exemptions: weekly $1,000 → $22.94', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        checkDate: '2026-08-15',
        workState: { code: 'OH' },
      }),
    );
    assert.equal(amountOf(r, 'OH_SIT'), dollars(22.94));
  });

  test('certificate.additionalWithholding (IT-4 Section II Line 5) works generically', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ohState({ exemptions: 1, additionalWithholding: dollars(15) }),
      }),
    );
    assert.equal(amountOf(r, 'OH_SIT'), dollars(22.57 + 15));
  });

  test('reciprocity (the actual fix): an Indiana resident working in Ohio owes $0 Ohio income tax', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        residenceState: { code: 'IN' },
        ...ohState({ exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'OH_SIT'), 0);
  });

  test('reciprocity does not over-apply: a New York resident working in Ohio still owes full Ohio tax', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        residenceState: { code: 'NY' },
        ...ohState({ exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'OH_SIT'), dollars(22.57));
  });

  test('all 5 reciprocal states (IN/KY/MI/PA/WV) zero Ohio tax the same way', () => {
    for (const code of ['IN', 'KY', 'MI', 'PA', 'WV']) {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          residenceState: { code },
          ...ohState({ exemptions: 1 }),
        }),
      );
      assert.equal(amountOf(r, 'OH_SIT'), 0, `expected $0 OH tax for a ${code} resident`);
    }
  });

  test("mid-year effective dating (the gap just closed): HB96's rate cut applies to checks on/after 2026-08-01, not before", () => {
    // Same $1,000/week, 1 exemption as the first test above, but priced on
    // the PRIOR (Oct 2025) table: base $8.89 not $8.02, top bracket 3.64%
    // vs 3.40% — (987.50 − 500.96) × 2.99% + 8.89 = $23.44.
    const beforeCutoff = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        checkDate: '2026-01-15',
        workState: { code: 'OH', certificate: { exemptions: 1 } },
      }),
    );
    assert.equal(amountOf(beforeCutoff, 'OH_SIT'), dollars(23.44));

    // The day before the cutover still uses the prior table...
    const dayBefore = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        checkDate: '2026-07-31',
        workState: { code: 'OH', certificate: { exemptions: 1 } },
      }),
    );
    assert.equal(amountOf(dayBefore, 'OH_SIT'), dollars(23.44));

    // ...and the cutover date itself already uses the new, lower table.
    const cutoverDay = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        checkDate: '2026-08-01',
        workState: { code: 'OH', certificate: { exemptions: 1 } },
      }),
    );
    assert.equal(amountOf(cutoverDay, 'OH_SIT'), dollars(22.57));
  });

  // Municipal (OH_LOCAL) and School District (OH_SDIT) income tax — closes
  // the gap where data/local/OH-municipalities-2026.json (679 jurisdictions)
  // and data/local/OH-school-districts-2026.json (214 districts) were fully
  // primary-sourced but never read by any calc code. Rates used below are
  // real, taken directly from those two files: Columbus 2.5%, Cincinnati
  // 1.8%, Cleveland 2.5%, Columbus Grove LSD (sdNumber 6901) 1.0%.
  describe('municipal income tax (OH_LOCAL)', () => {
    test('living and working in the same taxing city: tax fires once, not twice', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          checkDate: '2026-08-15',
          workState: {
            code: 'OH',
            certificate: { residenceCity: 'Columbus', workCity: 'Columbus' },
          },
        }),
      );
      assert.equal(amountOf(r, 'OH_LOCAL'), dollars(25.0));
    });

    test('home rate below work rate: home tax is fully credited away (ORC 718.121), only the work city collects', () => {
      // Cincinnati resident (1.8%) working in Columbus (2.5%): work tax
      // $25.00, home tax $18.00, credit = min(25, 18) = $18.00 -> net home
      // $0. Total $25.00 (never less than the higher of the two rates).
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          checkDate: '2026-08-15',
          workState: {
            code: 'OH',
            certificate: { residenceCity: 'Cincinnati', workCity: 'Columbus' },
          },
        }),
      );
      assert.equal(amountOf(r, 'OH_LOCAL'), dollars(25.0));
    });

    test('home rate above work rate: home city collects the difference on top of the work tax', () => {
      // Columbus resident (2.5%) working in Cincinnati (1.8%): work tax
      // $18.00, home tax $25.00, credit = min(18, 25) = $18.00 -> net home
      // $7.00. Total $25.00 (same total as above — a resident of the
      // higher-rate city always ends up paying that city's full rate).
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          checkDate: '2026-08-15',
          workState: {
            code: 'OH',
            certificate: { residenceCity: 'Columbus', workCity: 'Cincinnati' },
          },
        }),
      );
      assert.equal(amountOf(r, 'OH_LOCAL'), dollars(25.0));
    });

    test('work city only (no known residence city): taxed on the work rate alone', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          checkDate: '2026-08-15',
          workState: { code: 'OH', certificate: { workCity: 'Cleveland' } },
        }),
      );
      assert.equal(amountOf(r, 'OH_LOCAL'), dollars(25.0));
    });

    test('neither city is one of the 679 taxing municipalities: no OH_LOCAL line at all', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          checkDate: '2026-08-15',
          workState: { code: 'OH', certificate: { residenceCity: 'Nowhereville' } },
        }),
      );
      assert.equal(r.taxes.find((t) => t.id === 'OH_LOCAL'), undefined);
    });

    test('no city certificate at all: no OH_LOCAL line (not a silent $0 assumption)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          checkDate: '2026-08-15',
          workState: { code: 'OH', certificate: {} },
        }),
      );
      assert.equal(r.taxes.find((t) => t.id === 'OH_LOCAL'), undefined);
    });

    // ORC 718.011 occasional-entrant exemption — closed 2026-09-06, was
    // previously not modelled (or even disclosed) at all: the work-city
    // portion always fired starting day one.
    describe('occasional-entrant exemption (ORC 718.011)', () => {
      test('nonresident, not the principal workplace, 20 or fewer days worked: work-city tax exempt, no credit needed', () => {
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            checkDate: '2026-08-15',
            workState: {
              code: 'OH',
              certificate: {
                residenceCity: 'Cincinnati',
                workCity: 'Columbus',
                workCityIsPrincipalWorkplace: false,
                daysWorkedInMunicipality: 5,
              },
            },
          }),
        );
        // Only Cincinnati's own 1.8% home tax applies; Columbus is exempt.
        assert.equal(amountOf(r, 'OH_LOCAL'), dollars(18.0));
      });

      test('exactly at the 20-day threshold: still exempt (the statute says "20 or fewer")', () => {
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            checkDate: '2026-08-15',
            workState: {
              code: 'OH',
              certificate: {
                workCity: 'Columbus',
                workCityIsPrincipalWorkplace: false,
                daysWorkedInMunicipality: 20,
              },
            },
          }),
        );
        assert.equal(amountOf(r, 'OH_LOCAL'), dollars(0));
      });

      test('21 days worked: threshold exceeded, ordinary work-city tax applies', () => {
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            checkDate: '2026-08-15',
            workState: {
              code: 'OH',
              certificate: {
                workCity: 'Columbus',
                workCityIsPrincipalWorkplace: false,
                daysWorkedInMunicipality: 21,
              },
            },
          }),
        );
        assert.equal(amountOf(r, 'OH_LOCAL'), dollars(25.0));
      });

      test('principal workplace exception: exemption does not apply even under 20 days', () => {
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            checkDate: '2026-08-15',
            workState: {
              code: 'OH',
              certificate: {
                workCity: 'Columbus',
                workCityIsPrincipalWorkplace: true,
                daysWorkedInMunicipality: 3,
              },
            },
          }),
        );
        assert.equal(amountOf(r, 'OH_LOCAL'), dollars(25.0));
      });

      test('neither field supplied: defaults to pre-fix behavior (withhold), byte-identical to before this fix', () => {
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            checkDate: '2026-08-15',
            workState: { code: 'OH', certificate: { workCity: 'Columbus' } },
          }),
        );
        assert.equal(amountOf(r, 'OH_LOCAL'), dollars(25.0));
      });

      test('same city as residence: exemption is irrelevant (not a nonresident scenario) even if both fields are supplied', () => {
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            checkDate: '2026-08-15',
            workState: {
              code: 'OH',
              certificate: {
                residenceCity: 'Columbus',
                workCity: 'Columbus',
                workCityIsPrincipalWorkplace: false,
                daysWorkedInMunicipality: 3,
              },
            },
          }),
        );
        assert.equal(amountOf(r, 'OH_LOCAL'), dollars(25.0));
      });
    });
  });

  describe('School District Income Tax (OH_SDIT)', () => {
    test('a recognised sdNumber taxes wages at the district rate', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          checkDate: '2026-08-15',
          workState: { code: 'OH', certificate: { schoolDistrictCode: '6901' } },
        }),
      );
      assert.equal(amountOf(r, 'OH_SDIT'), dollars(10.0));
    });

    test('an unrecognised or absent sdNumber produces no OH_SDIT line', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          checkDate: '2026-08-15',
          workState: { code: 'OH', certificate: { schoolDistrictCode: '9999' } },
        }),
      );
      assert.equal(r.taxes.find((t) => t.id === 'OH_SDIT'), undefined);
    });
  });

  // JEDD/JEDZ income tax (OH_JEDD) — the case where "no municipality at
  // this address" was never the same thing as "no local tax". Rates below
  // are real, from data/local/OH-jedd-jedz-2026.json: Bath-Akron-Fairlawn
  // JEDD (Ohio zone id 9004) 2.5%, Ashtabula Township JEDD (9001) 1.8%.
  describe('JEDD/JEDZ income tax (OH_JEDD)', () => {
    test('taxes wages earned inside a zone, at the zone\'s own rate', () => {
      const r = calculatePaycheck(
        input({
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
          workState: { code: 'OH', certificate: { workJEDDId: '9004' } },
        }),
      );
      assert.equal(amountOf(r, 'OH_JEDD'), dollars(75.0));
      // No municipality exists at a JEDD address, so no municipal line
      // should appear alongside it.
      assert.equal(r.taxes.some((t) => t.id === 'OH_LOCAL'), false);
    });

    test('a different zone uses its own published rate, not a shared one', () => {
      const r = calculatePaycheck(
        input({
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
          workState: { code: 'OH', certificate: { workJEDDId: '9001' } },
        }),
      );
      assert.equal(amountOf(r, 'OH_JEDD'), dollars(54.0));
    });

    test('an address in no zone produces no line at all — closed list, not a default rate', () => {
      const r = calculatePaycheck(
        input({
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
          workState: { code: 'OH', certificate: {} },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'OH_JEDD'), false);
    });

    test('an unrecognised zone id is silent rather than guessed', () => {
      const r = calculatePaycheck(
        input({
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
          workState: { code: 'OH', certificate: { workJEDDId: '0000' } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'OH_JEDD'), false);
    });

    test('a JEDD and a school district can both apply to the same address', () => {
      // JEDD land sits in a township, and townships sit inside school
      // districts — the two taxes are independent and stack.
      const r = calculatePaycheck(
        input({
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
          workState: { code: 'OH', certificate: { workJEDDId: '9004', schoolDistrictCode: '6901' } },
        }),
      );
      assert.equal(amountOf(r, 'OH_JEDD'), dollars(75.0));
      assert.ok(amountOf(r, 'OH_SDIT') > dollars(0));
    });
  });

  // ORC 5747.06(A)(1)-(2): agricultural labor and domestic service in a
  // private home are exempt from Ohio withholding outright.
  describe('Exempt employment categories (ORC 5747.06(A))', () => {
    test('a household (domestic) worker owes $0 OH_SIT', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
          workState: { code: 'OH' },
          employmentCategory: 'household',
        }),
      );
      assert.equal(amountOf(r, 'OH_SIT'), 0);
    });

    test('an agricultural worker owes $0 OH_SIT', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
          workState: { code: 'OH' },
          employmentCategory: 'agricultural',
        }),
      );
      assert.equal(amountOf(r, 'OH_SIT'), 0);
    });

    test('clergy is NOT exempt under Ohio\'s own statute, unlike Alabama\'s', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
          workState: { code: 'OH' },
          employmentCategory: 'clergy',
        }),
      );
      assert.ok(amountOf(r, 'OH_SIT') > 0);
    });

    test('a standard employee is unaffected', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
          workState: { code: 'OH' },
        }),
      );
      assert.ok(amountOf(r, 'OH_SIT') > 0);
    });
  });
});

describe('Delaware', () => {
  // Expected values hand-derived from the Employer's Guide's own three
  // worked examples (Section 17), before the code was run, same discipline
  // as every other state. All three share the same $25,000 annualized-wage
  // starting point, isolating the standard-deduction and exemption-credit
  // differences between filing statuses while proving the shared bracket
  // lookup and annualization steps once. Delaware is the first state in
  // this project where the exemption amount is a CREDIT subtracted from
  // computed tax, not a deduction subtracted from wages before the bracket
  // lookup.
  const deState = (certificate: Record<string, unknown>) => ({
    workState: { code: 'DE', certificate },
  });

  test('Guide Example 1: single, 1 exemption, weekly (annualized $25,000)', () => {
    // $480.7692.../wk x52 = $25,000/yr. Less $3,250 standard deduction =
    // $21,750 taxable. Bracket 20,000-25,000 @ 5.20%, base $741: 741 +
    // 5.20%x1,750 = 741+91 = $832.00 tax. Less 1x$110 credit = $722.00
    // liability. ÷52 = $13.88 (Guide's own stated answer).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: Math.round(dollars(25000) / 52) }],
        ...deState({ maritalStatus: 'single', exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'DE_SIT'), dollars(13.88));
  });

  test('Guide Example 1, same $25,000/yr: biweekly/semi-monthly/monthly all match the Guide', () => {
    const annual = dollars(25000);
    const cases: [string, number, number][] = [
      ['biweekly', 26, 27.77],
      ['semimonthly', 24, 30.08],
      ['monthly', 12, 60.17],
    ];
    for (const [payFrequency, periods, expected] of cases) {
      const r = calculatePaycheck(
        input({
          payFrequency: payFrequency as PaycheckInput['payFrequency'],
          earnings: [{ code: 'REG', category: 'regular', amount: Math.round(annual / periods) }],
          ...deState({ maritalStatus: 'single', exemptions: 1 }),
        }),
      );
      assert.equal(amountOf(r, 'DE_SIT'), dollars(expected), `${payFrequency} should be ${expected}`);
    }
  });

  test('Guide Example 2: MFJ, 3 exemptions, same $25,000/yr — bigger deduction, bigger credit', () => {
    // $25,000/yr less $6,500 MFJ standard deduction = $18,500 taxable.
    // Bracket 10,000-20,000 @ 4.80%, base $261: 261 + 4.80%x8,500 =
    // 261+408 = $669.00 tax. Less 3x$110 credit = $339.00 liability.
    const annual = dollars(25000);
    const cases: [string, number, number][] = [
      ['weekly', 52, 6.52],
      ['biweekly', 26, 13.04],
      ['semimonthly', 24, 14.13],
      ['monthly', 12, 28.25],
    ];
    for (const [payFrequency, periods, expected] of cases) {
      const r = calculatePaycheck(
        input({
          payFrequency: payFrequency as PaycheckInput['payFrequency'],
          earnings: [{ code: 'REG', category: 'regular', amount: Math.round(annual / periods) }],
          ...deState({ maritalStatus: 'mfj', exemptions: 3 }),
        }),
      );
      assert.equal(amountOf(r, 'DE_SIT'), dollars(expected), `${payFrequency} should be ${expected}`);
    }
  });

  test('Guide Example 3: Married Filing Separately, 2 exemptions — uses the SINGLE standard deduction, not half of MFJ', () => {
    // $25,000/yr less $3,250 (single/MFS figure, NOT $3,250 = half of
    // $6,500 by coincidence of Delaware's own numbers) = $21,750 taxable,
    // same bracket math as Example 1 ($832.00 tax). Less 2x$110 credit =
    // $612.00 liability — proves MFS is NOT dispatched to the married
    // standard-deduction bucket.
    const annual = dollars(25000);
    const cases: [string, number, number][] = [
      ['weekly', 52, 11.77],
      ['biweekly', 26, 23.54],
      ['semimonthly', 24, 25.5],
      ['monthly', 12, 51.0],
    ];
    for (const [payFrequency, periods, expected] of cases) {
      const r = calculatePaycheck(
        input({
          payFrequency: payFrequency as PaycheckInput['payFrequency'],
          earnings: [{ code: 'REG', category: 'regular', amount: Math.round(annual / periods) }],
          ...deState({ maritalStatus: 'mfs', exemptions: 2 }),
        }),
      );
      assert.equal(amountOf(r, 'DE_SIT'), dollars(expected), `${payFrequency} should be ${expected}`);
    }
  });

  test("no certificate on file defaults to single, 0 exemptions (Guide Section 15(a)'s own default)", () => {
    // Same $25,000/yr, no certificate at all: single standard deduction,
    // same $832.00 tax as Example 1, but $0 credit (0 exemptions) instead
    // of Example 1's $110 — proving the no-certificate default is genuinely
    // "single, no allowances," not silently reusing whatever the last test
    // configured.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: Math.round(dollars(25000) / 52) }],
        workState: { code: 'DE' },
      }),
    );
    assert.equal(amountOf(r, 'DE_SIT'), dollars(16.0));
  });

  test('401(k) deferral reduces the DE base (federal-conformity state, unlike Pennsylvania)', () => {
    // $1,000/wk regular with a $200 401(k) deferral: DE taxable wages are
    // $800/wk = $41,600/yr (below the $60,000 floor, so a real bracket
    // shift versus the undeferred $52,000/yr would land in a lower band).
    // Annual $41,600 less $3,250 standard deduction = $38,350 taxable.
    // Bracket 25,000-60,000 @ 5.55%, base $1,001: 1,001 + 5.55%x13,350 =
    // 1,001+740.93 = $1,741.93 tax. Less 1x$110 credit = $1,631.93 liability
    // ÷52 = $31.38 (weekly, rounds from 31.3833).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(200) }],
        ...deState({ maritalStatus: 'single', exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'DE_SIT'), dollars(31.38));
  });

  test('no DE reciprocity: a Delaware resident working in Pennsylvania still owes full DE tax if DE is the work state', () => {
    // Confirms reciprocityExemptionReason() finds no match for DE (its own
    // reciprocalStates is empty) even when a residenceState is supplied —
    // Delaware's own Employer's Guide states directly it has no reciprocal
    // agreements with any state.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: Math.round(dollars(25000) / 52) }],
        workState: { code: 'DE', certificate: { maritalStatus: 'single', exemptions: 1 } },
        residenceState: { code: 'PA' },
      }),
    );
    assert.equal(amountOf(r, 'DE_SIT'), dollars(13.88));
  });

  // Wilmington Wage Tax (WILMINGTON_WAGE) — Delaware's only municipal wage
  // tax, 1.25% flat, fired by certificate.locality the same "resident OR
  // work location" shape as Missouri's KC/St. Louis earnings tax.
  describe('Wilmington Wage Tax (WILMINGTON_WAGE)', () => {
    test('certificate.locality = "Wilmington": 1.25% of wages', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'DE', certificate: { locality: 'Wilmington' } },
        }),
      );
      assert.equal(amountOf(r, 'WILMINGTON_WAGE'), dollars(12.5));
    });

    test('no certificate.locality: no WILMINGTON_WAGE line at all', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'DE' },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'WILMINGTON_WAGE'), false);
    });

    test('a different Delaware locality: no WILMINGTON_WAGE line (closed list of one)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'DE', certificate: { locality: 'Dover' } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'WILMINGTON_WAGE'), false);
    });
  });

  describe('supplemental wages (annual-marginal method, Employer\'s Guide Section 17)', () => {
    test('standalone bonus with prior regular payment: withheld at the MARGINAL annual rate, not re-annualized as if it were the regular wage', () => {
      // $2,000/wk regular (single, 0 exemptions) annualizes to $104,000,
      // taxed at $5,633.00/yr (verified separately below). A $5,000 bonus
      // on its own cheque pushes the annual total to $109,000 — entirely
      // inside DE's top 6.6% bracket (which starts at $60,000) — so the
      // marginal tax on the bonus alone is exactly $5,000 x 6.6% = $330.00.
      const regular = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
          ...deState({ maritalStatus: 'single', exemptions: 0 }),
        }),
      );
      assert.equal(amountOf(regular, 'DE_SIT'), dollars(108.33));

      const bonus = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(5000) }],
          ...deState({ maritalStatus: 'single', exemptions: 0 }),
          priorRegularPayment: {
            taxableWages: dollars(2000),
            stateIncomeTaxWithheld: amountOf(regular, 'DE_SIT'),
          },
        }),
      );
      assert.equal(amountOf(bonus, 'DE_SIT'), dollars(330));
    });

    test('standalone bonus with NO prior-payment context: falls back to the ordinary formula rather than throwing (a disclosed approximation, not a crash)', () => {
      const bonus = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(5000) }],
          ...deState({ maritalStatus: 'single', exemptions: 0 }),
        }),
      );
      // No assertion on the exact figure — this is the pre-existing
      // disclosed fallback (annualize the bonus alone through the
      // ordinary formula). The point of this test is that it computes
      // something rather than throwing when payroll history is absent.
      assert.ok(amountOf(bonus, 'DE_SIT') > 0);
    });

    test('a bonus paid ALONGSIDE regular wages on the same cheque is unaffected — only a bonus on its OWN cheque uses the annual-marginal path', () => {
      const combined = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [
            { code: 'REG', category: 'regular', amount: dollars(2000) },
            { code: 'BONUS', category: 'supplemental', amount: dollars(5000) },
          ],
          ...deState({ maritalStatus: 'single', exemptions: 0 }),
          priorRegularPayment: { taxableWages: dollars(2000), stateIncomeTaxWithheld: dollars(108.33) },
        }),
      );
      // $7,000 combined on ONE cheque should tax identically to $7,000 of
      // plain regular wages — priorRegularPayment must be ignored here
      // because this cheque itself carries non-supplemental cash, so the
      // ordinary per-cheque formula runs, not the annual-marginal split.
      const plain = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(7000) }],
          ...deState({ maritalStatus: 'single', exemptions: 0 }),
        }),
      );
      assert.equal(amountOf(combined, 'DE_SIT'), amountOf(plain, 'DE_SIT'));
    });
  });

  test('an unrecognized maritalStatus throws rather than silently falling through to single', () => {
    assert.throws(
      () => calculatePaycheck(input(deState({ maritalStatus: 'divorced', exemptions: 0 }))),
      /Unrecognized DE certificate\.maritalStatus/,
    );
  });
});

describe('Arizona', () => {
  // Arizona's own mechanism, not a bracket table: the employee elects a flat
  // percentage of gross taxable wages on Form A-4 (2026), or elects zero. No
  // certificate on file defaults to a flat 2.0% per the form's own words.
  const azState = (certificate?: Record<string, unknown>) => ({
    workState: { code: 'AZ', ...(certificate ? { certificate } : {}) },
  });

  test('elected 2.5% on Form A-4', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
        ...azState({ electedRate: 0.025 }),
      }),
    );
    assert.equal(amountOf(r, 'AZ_SIT'), dollars(75));
  });

  test('no Form A-4 on file defaults to the flat 2.0% HB 2119 rate', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
        ...azState(),
      }),
    );
    assert.equal(amountOf(r, 'AZ_SIT'), dollars(60));
  });

  test('zero-withholding election on Form A-4 produces $0, not the default rate', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
        ...azState({ zeroElection: true }),
      }),
    );
    assert.equal(amountOf(r, 'AZ_SIT'), 0);
  });

  test('BUG FIX: zeroElection: "false" (a string) throws rather than being silently treated as true', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'biweekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
            ...azState({ zeroElection: 'false' }),
          }),
        ),
      /Unrecognized certificate\.zeroElection/,
    );
  });

  test('an elected rate outside Form A-4\'s 7 published options throws rather than silently applying it', () => {
    // Found during an audit pass: the original implementation cast
    // certificate.electedRate straight to a number and applied it via
    // applyRate() with no check against Arizona's own closed list of legal
    // rates (0.5/1.0/1.5/2.0/2.5/3.0/3.5%) — a caller-supplied 12% (a
    // plausible typo for '1.2%', or a copy-paste from a different state's
    // rate) would have silently withheld 6x too much with no error at all.
    // Every other state's own enum-like certificate field in this project
    // (marital status codes, withholding codes, filing statuses) throws on
    // an unrecognized value; Arizona's rate election is exactly that kind
    // of closed-list field and was the one exception.
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'biweekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
            ...azState({ electedRate: 0.12 }),
          }),
        ),
      /Unrecognized AZ certificate\.electedRate/,
    );
  });

  describe('reciprocity (Form WEC) — conditional on nonresident-credit eligibility, not bare residence', () => {
    // Arizona's own bug class: unlike IL/IN/KY/MI/MN/OH/PA/WI's unconditional
    // "resides there" pacts, Form WEC only exempts a CA/IN/OR/VA resident who
    // is ALSO "allowed to claim a tax credit... on Form 140NR" — modelled via
    // reciprocity.creditEligibilityRequiredStates and
    // certificate.nonresidentCreditEligible on the EMPLOYEE'S OWN
    // (residence-state) certificate, the same default-safe shape Kentucky/
    // Virginia's dailyCommuter gate already uses.
    test('a California resident with no eligibility assertion owes FULL Arizona tax, not $0', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
          workState: { code: 'AZ' },
          residenceState: { code: 'CA' },
        }),
      );
      assert.equal(amountOf(r, 'AZ_SIT'), dollars(60)); // default 2.0%, same as no-form-on-file
    });

    test('a California resident who asserts nonresidentCreditEligible gets the exemption', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
          workState: { code: 'AZ' },
          residenceState: { code: 'CA', certificate: { nonresidentCreditEligible: true } },
        }),
      );
      assert.equal(amountOf(r, 'AZ_SIT'), 0);
    });

    test('all four states (CA/IN/OR/VA) use the same eligibility gate', () => {
      for (const residence of ['CA', 'IN', 'OR', 'VA']) {
        const r = calculatePaycheck(
          input({
            payFrequency: 'biweekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
            workState: { code: 'AZ' },
            residenceState: { code: residence, certificate: { nonresidentCreditEligible: true } },
          }),
        );
        assert.equal(amountOf(r, 'AZ_SIT'), 0, `${residence} resident should owe $0 AZ tax`);
      }
    });

    test('a non-reciprocal-state resident (Texas) gets no exemption even with the flag asserted', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
          workState: { code: 'AZ' },
          residenceState: { code: 'TX', certificate: { nonresidentCreditEligible: true } },
        }),
      );
      assert.equal(amountOf(r, 'AZ_SIT'), dollars(60));
    });

    test('the asymmetry Oregon\'s own guide confirms: an Arizona resident working in Oregon gets no matching OR exemption', () => {
      // OR-2026.json's own reciprocity.rule: "NONE" — Oregon withholds from
      // every nonresident regardless of home state. This is the OTHER
      // direction of the one-directional relationship AZ's own data
      // discloses (orAsymmetryConfirmed): the AZ exemption for OR residents
      // above has no mirror image here.
      const r = calculatePaycheck(
        input({
          payFrequency: 'monthly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(4000) }],
          workState: { code: 'OR', certificate: { maritalStatus: 'single', allowances: 0 } },
          residenceState: { code: 'AZ', certificate: { nonresidentCreditEligible: true } },
        }),
      );
      assert.ok(amountOf(r, 'OR_SIT') > 0, 'Oregon must still withhold from an Arizona resident');
    });
  });
});

describe('Missouri', () => {
  // Expected values reproduce the 2026 Missouri Withholding Tax Formula's
  // OWN worked example (married, spouse works, $35,000 annual, monthly
  // $59) — monthly wages chosen as $2,916.67 so that x12 lands within 4
  // cents of the source's stated $35,000 annual figure; verified by hand
  // that the 4-cent difference doesn't shift the bracket or the rounded
  // answer. roundFinalToWholeDollar (the same generic mechanism built for
  // Maine) is what turns the raw $58.98 into the source's stated $59.
  test("reproduces the DOR's own worked example: married/spouse-works, monthly $2,916.67", () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2916.67) }],
        workState: { code: 'MO' },
      }),
    );
    assert.equal(amountOf(r, 'MO_SIT'), dollars(59));
  });

  test('married, spouse does not work gets DOUBLE the standard deduction', () => {
    // Annual $35,000.04 (2,916.67 x 12), deduction $32,200 (2x $16,100) ->
    // taxable $2,800.04 -> falls in the 3rd bracket ($2,696-$4,044, base
    // $27, rate 2.5%), NOT the 2nd: 27.00 + (2,800.04-2,696) x 2.5% =
    // 27.00 + 2.60 = 29.60/yr -> /12 = 2.4667 -> raw $2.47, rounds to the
    // nearest WHOLE DOLLAR (Missouri's final-rounding rule) = $2.
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2916.67) }],
        workState: { code: 'MO', certificate: { filingStatus: 'married_spouse_does_not_work' } },
      }),
    );
    assert.equal(amountOf(r, 'MO_SIT'), dollars(2));
  });

  test('Kansas City earnings tax: 1% via certificate.locality, not tied to residence vs. work-location logic', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2916.67) }],
        workState: { code: 'MO', certificate: { locality: 'Kansas City' } },
      }),
    );
    assert.equal(amountOf(r, 'KC_EARN'), dollars(29.17));
    assert.equal(r.taxes.some((t) => t.id === 'STL_EARN' || t.id === 'STL_PAYROLL_ER'), false);
  });

  test('St. Louis: BOTH the 1% employee earnings tax AND the separate 0.5% employer payroll expense tax fire', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2916.67) }],
        workState: { code: 'MO', certificate: { locality: 'St. Louis' } },
      }),
    );
    assert.equal(amountOf(r, 'STL_EARN'), dollars(29.17));
    assert.equal(amountOf(r, 'STL_PAYROLL_ER'), dollars(14.58));
  });

  test('no certificate.locality at all means neither city tax fires', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2916.67) }],
        workState: { code: 'MO' },
      }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'KC_EARN' || t.id === 'STL_EARN'), false);
  });

  test('an unrecognized filingStatus throws rather than silently landing in the lowest-deduction bucket', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'monthly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(2916.67) }],
            workState: { code: 'MO', certificate: { filingStatus: 'divorced' } },
          }),
        ),
      /Unrecognized MO certificate\.filingStatus/,
    );
  });
});

describe('Nebraska', () => {
  // Hand-derived from Circular EN's own verified ANNUAL bracket table (no
  // official per-period worked example was available in the source —
  // Circular EN's per-period tables extracted garbled and were not
  // transcribed; this exercises the annualize-then-divide approximation
  // disclosed in NE-2026.json rather than reproducing a published cell).
  test('single, weekly $500, 0 allowances', () => {
    // Annual net = 500 x 52 = 26,000 (0 allowances, no subtraction).
    // Bracket [21,810-31,610, base 560.35, rate 4.21%]: 560.35 +
    // (26,000-21,810) x 4.21% = 560.35 + 176.40 = 736.75 (fees applyRate's
    // own rounding: 4,190 x 0.0421 = 176.399 -> rounds to 176.40).
    // /52 = 14.168... -> rounds to 14.17.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        workState: { code: 'NE', certificate: { maritalStatus: 'single', allowances: 0 } },
      }),
    );
    assert.equal(amountOf(r, 'NE_SIT'), dollars(14.17));
  });

  test('allowances reduce the base before the PER-PERIOD bracket lookup (real table, not annualize-and-divide)', () => {
    // Same $500/week, 2 allowances: 2 x $46.92 = $93.84 subtracted PER
    // PERIOD first (WEEKLY table's own allowance value, not annualized).
    // Net = 500 - 93.84 = 406.16/wk, which falls in the weekly SINGLE
    // table's own [$129-$419, base $1.42, rate 3.22%] bracket directly (no
    // annualizing involved): 1.42 + (406.16-129) x 3.22% = 1.42 + 277.16 x
    // 0.0322 = 1.42 + 8.92 (277.16 x 0.0322 = 8.924552, rounds DOWN to
    // 8.92, not 8.93) = $10.34.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        workState: { code: 'NE', certificate: { maritalStatus: 'single', allowances: 2 } },
      }),
    );
    assert.equal(amountOf(r, 'NE_SIT'), dollars(10.34));
  });

  test('quarterly $9,000 proves the REAL per-period table is in use, not the old annualize-then-divide approximation', () => {
    // Real quarterly table, bracket [$7,903-$10,033, base $243.24, rate
    // 4.35%]: 243.24 + (9,000-7,903) x 4.35% = 243.24 + 1,097 x 0.0435 =
    // 243.24 + 47.72 (1,097 x 0.0435 = 47.7195, rounds to 47.72) = $290.96.
    // The OLD annualize-then-divide approximation this file used before the
    // real per-period tables were recovered would instead have annualized
    // to $36,000, used the ANNUAL bracket [$31,610-$40,130, base $972.93,
    // rate 4.35%] -> 972.93 + 4,390 x 4.35% = 1,163.90/yr -> /4 = $290.975,
    // rounding HALF UP to $290.98 — a real 2-cent difference from the
    // correct $290.96, verified independently before writing this fixture,
    // that this test exists specifically to catch if the wiring ever
    // regresses back to the approximation.
    const r = calculatePaycheck(
      input({
        payFrequency: 'quarterly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(9000) }],
        workState: { code: 'NE', certificate: { maritalStatus: 'single', allowances: 0 } },
      }),
    );
    assert.equal(amountOf(r, 'NE_SIT'), dollars(290.96));
  });
});

describe('Oregon', () => {
  describe("Workers' Benefit Fund (OAR 436-070-0020)", () => {
    const or = (overrides: Partial<PaycheckInput>) =>
      calculatePaycheck(input({ workState: { code: 'OR', certificate: {} }, ...overrides }));

    test('flat-rate hours when hoursWorked is absent: biweekly 80 h x $0.009 = $0.72 employee, $0.72 employer (matches PaycheckCity)', () => {
      const r = or({ payFrequency: 'biweekly' });
      assert.equal(amountOf(r, 'OR_WBF_EE'), dollars(0.72));
      assert.equal(amountOf(r, 'OR_WBF_ER'), dollars(0.72));
    });

    test('monthly 173.33 h -> $1.56; semimonthly 86.665 h -> $0.78 (half a cent rounds up)', () => {
      assert.equal(amountOf(or({ payFrequency: 'monthly' }), 'OR_WBF_EE'), dollars(1.56));
      assert.equal(amountOf(or({ payFrequency: 'semimonthly' }), 'OR_WBF_EE'), dollars(0.78));
    });

    test('actual hours win over the flat rate: 45.5 h x $0.009 = $0.4095 -> $0.41', () => {
      const r = or({ payFrequency: 'weekly', hoursWorked: 45.5 });
      assert.equal(amountOf(r, 'OR_WBF_EE'), dollars(0.41));
    });

    test('no line for zero hours, and none outside Oregon', () => {
      assert.equal(or({ hoursWorked: 0 }).taxes.some((t) => t.id.startsWith('OR_WBF')), false);
      const wa = calculatePaycheck(input({ workState: { code: 'WA', certificate: {} } }));
      assert.equal(wa.taxes.some((t) => t.id.includes('WBF')), false);
    });
  });

  // Oregon is the first state in this project whose formula depends on the
  // employee's own COMPUTED FEDERAL WITHHOLDING, not just federally-defined
  // wage categories. These fixtures were verified two ways: (1) an
  // independent standalone reimplementation of the formula (deliberately
  // separate from state.ts, the same discipline used for Connecticut, since
  // Oregon publishes no cent-exact worked example using REAL federal
  // withholding — its own Example 1 assumes an illustrative $1,000 federal
  // figure that doesn't correspond to any real 2026 federal computation);
  // (2) reading the actual engine's own detail string for the same inputs
  // and confirming every intermediate figure matches by hand.
  test('single, weekly $1,000, 0 allowances — real federal withholding as input', () => {
    // Engine computes US_FIT = $78.08/wk (annualized $4,060.16). Annual OR
    // wages = $52,000 (>= $50,000, so the phase-out-cap table applies, but
    // $4,060.16 is under the $8,750 cap so the full federal figure is
    // subtracted, uncapped in practice). BASE = 52,000 - 4,060.16 - 2,910
    // (single, <3 allowances) = 45,029.84. Bracket [11,400-125,000, base
    // 678, rate 8.75%]: 678 + (45,029.84-11,400) x 8.75% = 678 + 2,942.61
    // = 3,620.61. No exemption credit (0 allowances). /52 = 69.628... ->
    // 69.63.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR', certificate: { maritalStatus: 'single', allowances: 0 } },
      }),
    );
    assert.equal(amountOf(r, 'OR_SIT'), dollars(69.63));
  });

  test('married, 2 allowances, monthly $10,000, federal-exempt — promoted bracket + exemption credit', () => {
    // federalW4.exempt=true isolates the OR-specific arithmetic from
    // federal's own formula for this fixture. Annual wages $120,000 (>=
    // $50,000, married schedule). BASE = 120,000 - 0 (federal) - 5,820
    // (married deduction) = 114,180. Bracket [22,800-250,000, base
    // 1,357, rate 8.75%]: 1,357 + (114,180-22,800) x 8.75% = 1,357 +
    // 7,995.75 = 9,352.75. Less 2 x $263 = $526 exemption credit =
    // 8,826.75. /12 = 735.5625 -> rounds to 735.56.
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(10000) }],
        federalW4: {
          filingStatus: 'single',
          multipleJobs: false,
          dependentCredit: 0,
          otherIncome: 0,
          deductions: 0,
          extraWithholding: 0,
          exempt: true,
        },
        workState: { code: 'OR', certificate: { maritalStatus: 'married', allowances: 2 } },
      }),
    );
    assert.equal(amountOf(r, 'OR_SIT'), dollars(735.56));
  });

  test('high earner: the federal-subtraction cap phases all the way down to $0, using REAL computed federal withholding', () => {
    // Weekly $3,000 (annual $156,000), single, 0 allowances. This is the
    // fixture that actually exercises the phase-out CAP TABLE — every
    // other Oregon fixture either used federal-exempt (cap logic runs but
    // multiplies against $0 either way) or stayed under the cap ceiling
    // entirely. At $156,000, real federal withholding is a substantial
    // $503.35/wk ($26,174.20/yr annualized) — but Oregon's own phase-out
    // schedule's LAST tier (wages >= $145,000, single) caps the federal
    // subtraction at exactly $0, so none of that real federal withholding
    // reduces the Oregon base at all. BASE = 156,000 - 0 - 2,910 (single
    // deduction) = 153,090. Bracket [125,000+, base 10,618, rate 9.9%]:
    // 10,618 + (153,090-125,000) x 9.9% = 10,618 + 2,780.91 = 13,398.91/yr
    // -> /52 = 257.6714... -> $257.67. Verified first by running the real
    // engine and reading its own detail string ("less $0.00 federal
    // (capped $0.00)"), then independently re-deriving every intermediate
    // figure by hand before trusting it.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
        workState: { code: 'OR', certificate: { maritalStatus: 'single', allowances: 0 } },
      }),
    );
    assert.equal(amountOf(r, 'OR_SIT'), dollars(257.67));
  });

  test('no Form OR-W-4 on file defaults to a flat 8% (HB 2119), skipping the whole formula', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR' },
      }),
    );
    assert.equal(amountOf(r, 'OR_SIT'), dollars(80));
  });

  test('Statewide Transit Tax: flat 0.1%, uncapped, on top of OR_SIT', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR' },
      }),
    );
    assert.equal(amountOf(r, 'OR_STT'), dollars(1));
  });

  test('Paid Leave Oregon: employee share fires generically via statePaidLeaveEmployeeTax()', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR' },
      }),
    );
    assert.equal(amountOf(r, 'OR_PFML_EE'), dollars(6));
  });

  test('Paid Leave Oregon: employer share only fires when the caller sets certificate.employerLiableForPaidLeaveShare', () => {
    const withoutFlag = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR' },
      }),
    );
    assert.equal(withoutFlag.taxes.some((t) => t.id === 'OR_PFML_ER'), false);

    const withFlag = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR', certificate: { employerLiableForPaidLeaveShare: true } },
      }),
    );
    assert.equal(amountOf(withFlag, 'OR_PFML_ER'), dollars(4));
  });

  test('TriMet transit district tax (employer-paid) rounds DOWN, not half-up', () => {
    // 1,000 x 0.008237 = 8.237 -> rounds down to $8.23, NOT $8.24.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR', certificate: { locality: 'TriMet' } },
      }),
    );
    assert.equal(amountOf(r, 'TRIMET_ER'), dollars(8.23));
    assert.equal(r.taxes.some((t) => t.id === 'LTD_ER'), false);
  });

  test('Lane Transit District tax fires instead of TriMet when certificate.locality is LTD', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR', certificate: { locality: 'LTD' } },
      }),
    );
    assert.equal(amountOf(r, 'LTD_ER'), dollars(8));
  });

  test('Canby Area Transit tax rounds HALF-UP, not down like TriMet/LTD', () => {
    // 837.50 x 0.006 = 5.025 -> rounds to $5.03 under this project's
    // ordinary round-half-up (Math.round(502.5) = 503 cents), NOT $5.02
    // the way TriMet's floor-based rounding would give.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(837.5) }],
        workState: { code: 'OR', certificate: { locality: 'CanbyTransit' } },
      }),
    );
    assert.equal(amountOf(r, 'CANBY_TRANSIT_ER'), dollars(5.03));
    assert.equal(r.taxes.some((t) => t.id === 'TRIMET_ER'), false);
  });

  test('Sandy transit tax fires off certificate.locality = SandyTransit', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR', certificate: { locality: 'SandyTransit' } },
      }),
    );
    assert.equal(amountOf(r, 'SANDY_TRANSIT_ER'), dollars(6));
  });

  test('Wilsonville (SMART) transit tax fires off certificate.locality = SMART', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR', certificate: { locality: 'SMART' } },
      }),
    );
    assert.equal(amountOf(r, 'SMART_ER'), dollars(5));
  });

  test('South Clackamas Transportation District tax fires off certificate.locality = SCTD', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR', certificate: { locality: 'SCTD' } },
      }),
    );
    assert.equal(amountOf(r, 'SCTD_ER'), dollars(5));
  });

  test('an unrecognised certificate.locality produces no Oregon transit district tax line at all', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR', certificate: { locality: 'SomeOtherCity' } },
      }),
    );
    for (const id of ['TRIMET_ER', 'LTD_ER', 'CANBY_TRANSIT_ER', 'SANDY_TRANSIT_ER', 'SMART_ER', 'SCTD_ER']) {
      assert.equal(r.taxes.some((t) => t.id === id), false, `${id} should not fire`);
    }
  });

  test('Metro Supportive Housing Services Tax: nothing below the $200k YTD trigger, taxed above it', () => {
    // $5,000 this week, $199,000 already YTD -> crosses $200,000 mid-cheque:
    // only the $4,000 above the trigger is taxed, at 1% = $40.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        workState: { code: 'OR', certificate: { metroDistrict: true } },
        ytd: {
          socialSecurity: 0,
          medicare: 0,
          futa: 0,
          localIncomeTax: { OR_METRO: dollars(199000) },
        },
      }),
    );
    assert.equal(amountOf(r, 'OR_METRO_SHS'), dollars(40));
  });

  test('Multnomah PFA: two-tier threshold, both tiers taxed at 1.5% independently once both are crossed', () => {
    // $5,000 this week, $399,000 already YTD -> the FULL $5,000 sits above
    // the $200k tier (1.5%) AND $4,000 of it sits above the $400k tier (an
    // ADDITIONAL 1.5%): 5,000 x 1.5% + 4,000 x 1.5% = 75 + 60 = $135.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        workState: { code: 'OR', certificate: { multnomahCounty: true } },
        ytd: {
          socialSecurity: 0,
          medicare: 0,
          futa: 0,
          localIncomeTax: { OR_MULTNOMAH: dollars(399000) },
        },
      }),
    );
    assert.equal(amountOf(r, 'OR_MULTNOMAH_PFA'), dollars(135));
  });

  test('an employee inside BOTH the Metro district and Multnomah County gets both local lines', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        workState: { code: 'OR', certificate: { metroDistrict: true, multnomahCounty: true } },
        ytd: {
          socialSecurity: 0,
          medicare: 0,
          futa: 0,
          localIncomeTax: { OR_METRO: dollars(199000), OR_MULTNOMAH: dollars(399000) },
        },
      }),
    );
    assert.equal(amountOf(r, 'OR_METRO_SHS'), dollars(40));
    assert.equal(amountOf(r, 'OR_MULTNOMAH_PFA'), dollars(135));
  });

  test('below both Portland-area thresholds, neither local line appears at all', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'OR', certificate: { metroDistrict: true, multnomahCounty: true } },
      }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'OR_METRO_SHS'), true);
    assert.equal(amountOf(r, 'OR_METRO_SHS'), 0);
    assert.equal(amountOf(r, 'OR_MULTNOMAH_PFA'), 0);
  });

  test('an unrecognized maritalStatus throws rather than silently falling through to single', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
            workState: { code: 'OR', certificate: { maritalStatus: 'divorced', allowances: 0 } },
          }),
        ),
      /Unrecognized OR certificate\.maritalStatus/,
    );
  });
});

describe('California', () => {
  // Reproduces ALL SIX of EDD's own published worked examples (2026
  // Withholding Schedules, Method B) — a rarer luxury than most states in
  // this project get. Examples A-D use the SAME direct per-period Tables
  // 5-28 this engine implements and match to the cent exactly. Examples E
  // and F use a DIFFERENT valid method EDD itself offers (annualize gross
  // wages and the ANNUAL standard deduction, compute on the annual table,
  // divide back down) — genuinely NOT the same arithmetic path, and EDD's
  // own per-period standard-deduction figures are independently rounded
  // rather than pure annual/N division, so the two methods land a cent or
  // two apart on the same inputs. E/F below assert the CORRECT answer for
  // THIS function's own (primary, per-period-table) method, not EDD's
  // published annualized-method answer — see californiaWithholding()'s own
  // doc comment for the full arithmetic showing both paths.
  const caState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'CA', certificate },
  });

  test('Example A: weekly $210, single, 1 allowance — below the Low Income Exemption threshold, $0', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(210) }],
        ...caState({ filingStatus: 'single_or_married_two_incomes', regularAllowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'CA_SIT'), 0);
  });

  test('Example B: biweekly $1,600, married, 2 regular + 1 estimated-deduction allowance -> $2.38', () => {
    // The estimated-deduction allowance is NOT counted toward the Table 4
    // exemption credit (Method B's own footnote 1) — only the 2 regular
    // ones are. $1,600 - $38 (Table 2, 1 allowance) = $1,562 - $439
    // (Table 3, married/2+ allowances) = $1,123 taxable -> Table 27 bracket
    // [$852-$2,020, base $9.37, 2.2%]: $9.37 + 2.2%x$271 = $15.33 - $12.95
    // (Table 4, 2 allowances) = $2.38.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1600) }],
        ...caState({ filingStatus: 'married_one_income', regularAllowances: 2, estimatedDeductionAllowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'CA_SIT'), dollars(2.38));
  });

  test('Example C: monthly $5,100, married, 5 allowances -> $0.82', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5100) }],
        ...caState({ filingStatus: 'married_one_income', regularAllowances: 5 }),
      }),
    );
    assert.equal(amountOf(r, 'CA_SIT'), dollars(0.82));
  });

  test('Example D: weekly $950, head of household, 3 allowances -> $1.69', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(950) }],
        ...caState({ filingStatus: 'hoh', regularAllowances: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'CA_SIT'), dollars(1.69));
  });

  test('Example E scenario (semi-monthly $2,400, married, 4 allowances): $4.11 via this method, NOT EDD\'s own $4.13 annualized-method answer', () => {
    // Direct per-period path (this function): $2,400 - $476 (Table 3,
    // married/2+, semimonthly) = $1,924 taxable -> Table 18 bracket
    // [$924-$2,188, base $10.16, 2.2%]: $10.16 + 2.2%x$1,000 = $32.16 -
    // $28.05 (Table 4, 4 allowances) = $4.11. EDD's OWN example computes
    // this via annualizing first ($57,600 - $11,412 = $46,188 taxable,
    // $772.40 computed, -$673.20 credit = $99.20/yr / 24 = $4.13) — a
    // genuinely different, EDD-sanctioned method this engine doesn't
    // implement, landing 2 cents apart due to the semimonthly Table 3
    // figure ($476) not being pure annual-divided-by-24 ($475.50).
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2400) }],
        ...caState({ filingStatus: 'married_one_income', regularAllowances: 4 }),
      }),
    );
    assert.equal(amountOf(r, 'CA_SIT'), dollars(4.11));
  });

  test('Example F scenario (monthly $4,750, married, 4 allowances): $7.15 via this method, NOT EDD\'s own $7.17 annualized-method answer', () => {
    // Same divergence class as Example E, for the same disclosed reason.
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(4750) }],
        ...caState({ filingStatus: 'married_one_income', regularAllowances: 4 }),
      }),
    );
    assert.equal(amountOf(r, 'CA_SIT'), dollars(7.15));
  });

  test('no DE 4 on file defaults to Single with zero allowances', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(950) }],
        workState: { code: 'CA' },
      }),
    );
    // Same $950 weekly wage as Example D, but single/0-allowances instead
    // of HOH/3-allowances: threshold $363 (lower bucket) crossed, std
    // deduction $110 (lower), taxable $840 -> Table 23 bracket
    // [$797-$1,107, base $21.61, 6.6%]: $21.61 + 6.6%x$43 = $24.45, no
    // credit (0 allowances) = $24.45.
    assert.equal(amountOf(r, 'CA_SIT'), dollars(24.45));
  });

  test('SDI: $1,000 x 1.3%, uncapped', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'CA' },
      }),
    );
    assert.equal(amountOf(r, 'CA_DBL_EE'), dollars(13));
  });

  // DE 44's own two-tier flat supplemental rate — bonuses/stock options at
  // 10.23%, everything else DE 44 also calls supplemental (overtime,
  // commissions, sales awards, severance, vacation pay) at 6.6%, both
  // employer options and both gated on the supplemental wage NOT being
  // paid at the same time as regular wages.
  describe('Supplemental wages (DE 44)', () => {
    test('a standalone $5,000 bonus, employer elects the flat method -> exactly 10.23%', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(5000) }],
          workState: { code: 'CA', certificate: { regularAllowances: 0 } },
          employer: { supplementalFlatRateElection: { CA: true } },
        }),
      );
      assert.equal(amountOf(r, 'CA_SIT_SUPP_BONUS'), dollars(511.5));
      // No regular wages this cheque -> the ordinary CA_SIT line sees $0 base.
      assert.equal(amountOf(r, 'CA_SIT'), 0);
    });

    test('the same bonus taxed as a stock option (code contains "stock") also gets 10.23%', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'STOCK_OPTION', category: 'supplemental', amount: dollars(5000) }],
          workState: { code: 'CA', certificate: { regularAllowances: 0 } },
          employer: { supplementalFlatRateElection: { CA: true } },
        }),
      );
      assert.equal(amountOf(r, 'CA_SIT_SUPP_BONUS'), dollars(511.5));
    });

    test('a standalone $2,000 commission, employer elects the flat method -> exactly 6.6% (DE 44\'s "other types" bucket)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'COMM', category: 'supplemental', amount: dollars(2000) }],
          workState: { code: 'CA', certificate: { regularAllowances: 0 } },
          employer: { supplementalFlatRateElection: { CA: true } },
        }),
      );
      assert.equal(amountOf(r, 'CA_SIT_SUPP_OTHER'), dollars(132.0));
      assert.equal(r.taxes.some((t) => t.id === 'CA_SIT_SUPP_BONUS'), false);
    });

    test('a bonus AND a commission on the same standalone cheque produce two separate flat lines', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [
            { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
            { code: 'COMM', category: 'supplemental', amount: dollars(500) },
          ],
          workState: { code: 'CA', certificate: { regularAllowances: 0 } },
          employer: { supplementalFlatRateElection: { CA: true } },
        }),
      );
      assert.equal(amountOf(r, 'CA_SIT_SUPP_BONUS'), dollars(102.3)); // 1000 * 10.23%
      assert.equal(amountOf(r, 'CA_SIT_SUPP_OTHER'), dollars(33.0)); // 500 * 6.6%
    });

    test('without the employer election, no flat line fires — the bonus runs through the ordinary formula instead', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(5000) }],
          workState: { code: 'CA', certificate: { regularAllowances: 0 } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'CA_SIT_SUPP_BONUS'), false);
      assert.equal(r.taxes.some((t) => t.id === 'CA_SIT_SUPP_OTHER'), false);
      assert.ok(amountOf(r, 'CA_SIT') > 0);
    });

    test('BUG FIX: a pretax deduction on a bonus-only cheque reduces the taxable base, allocated proportionally across bonus/other', () => {
      // $1,000 bonus + $500 commission (both supplemental, no regular
      // wages), employer elects the flat method, and a $1,000 401(k)
      // deferral. Before this fix, the carve-out ignored pretax entirely —
      // the deferral vanished and the full $1,500 was taxed. Raw total
      // $1,500 less $1,000 pretax = $500 taxable, allocated proportionally
      // (2:1 bonus:other, matching the raw 1,000:500 split): bonus
      // $333.33 @ 10.23% = $34.10, other $166.67 @ 6.6% = $11.00.
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [
            { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
            { code: 'COMM', category: 'supplemental', amount: dollars(500) },
          ],
          deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(1000) }],
          workState: { code: 'CA', certificate: { regularAllowances: 0 } },
          employer: { supplementalFlatRateElection: { CA: true } },
        }),
      );
      assert.equal(amountOf(r, 'CA_SIT_SUPP_BONUS'), dollars(34.1));
      assert.equal(amountOf(r, 'CA_SIT_SUPP_OTHER'), dollars(11.0));
    });

    test('DE 44: a bonus paid ALONGSIDE regular wages is required to be treated as regular wages, never the flat rate, even if elected', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [
            { code: 'REG', category: 'regular', amount: dollars(3000) },
            { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
          ],
          workState: { code: 'CA', certificate: { regularAllowances: 0 } },
          employer: { supplementalFlatRateElection: { CA: true } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'CA_SIT_SUPP_BONUS'), false);
      assert.equal(r.taxes.some((t) => t.id === 'CA_SIT_SUPP_OTHER'), false);
      // The full $4,000 must still be taxed exactly once through CA_SIT,
      // not silently dropped — compare against the same $4,000 paid as
      // ordinary regular wages with nothing categorized supplemental.
      const combined = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(4000) }],
          workState: { code: 'CA', certificate: { regularAllowances: 0 } },
        }),
      );
      assert.equal(amountOf(r, 'CA_SIT'), amountOf(combined, 'CA_SIT'));
    });

    test('DE 44 Option 1 (aggregate with the prior/current regular payment) still works via input.priorRegularPayment, with no flat line', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(3000) }],
          workState: { code: 'CA', certificate: { regularAllowances: 0 } },
          priorRegularPayment: { taxableWages: dollars(3000), stateIncomeTaxWithheld: dollars(80) },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'CA_SIT_SUPP_BONUS'), false);
      assert.ok(amountOf(r, 'CA_SIT') > 0);
    });
  });
});

describe('Colorado', () => {
  // DR 1098 publishes no full worked example with a stated dollar answer
  // the way California/Utah's guides do, so these are hand-derived from
  // the worksheet's own formula, independently verified before running.
  const coState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'CO', certificate },
  });

  test('single/other filing status, weekly $1,000: $5,500 deduction, 4.40% flat', () => {
    // Annual 52,000 - 5,500 = 46,500 x 4.40% = 2,046.00/yr / 52 = 39.346... -> $39.35.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...coState({ filingStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'CO_SIT'), dollars(39.35));
  });

  test('MFJ gets the $11,000 deduction, not $5,500', () => {
    // Annual 52,000 - 11,000 = 41,000 x 4.40% = 1,804.00/yr / 52 = 34.6923... -> $34.69.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...coState({ filingStatus: 'mfj' }),
      }),
    );
    assert.equal(amountOf(r, 'CO_SIT'), dollars(34.69));
  });

  test('DR 0004 Line 2 REPLACES the flat deduction, not adds to it', () => {
    // Same wages/status as the first test, but an $8,000 DR 0004 override
    // instead of the $5,500 default: 52,000 - 8,000 = 44,000 x 4.40% =
    // 1,936.00/yr / 52 = 37.2307... -> $37.23 (not $39.35).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...coState({ filingStatus: 'single', dr0004Line2Amount: 8000 }),
      }),
    );
    assert.equal(amountOf(r, 'CO_SIT'), dollars(37.23));
  });

  test('no W-4/DR 0004 on file defaults to single ($5,500 deduction)', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'CO' },
      }),
    );
    assert.equal(amountOf(r, 'CO_SIT'), dollars(39.35));
  });

  test('FAMLI employee share: $1,000 x 0.44%', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'CO' },
      }),
    );
    assert.equal(amountOf(r, 'CO_PFML_EE'), dollars(4.4));
  });

  test('FAMLI employer share (10+ employees): total premium less employee share', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'CO', certificate: { employerLiableForPaidLeaveShare: true } },
      }),
    );
    // Total premium 1,000 x 0.88% = 8.80, less employee share (4.40) = 4.40.
    assert.equal(amountOf(r, 'CO_PFML_ER'), dollars(4.4));
  });

  test('no FAMLI employer-share line by default (under-10-employee assumption)', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'CO' },
      }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'CO_PFML_ER'), false);
  });

  // Denver's Occupational Privilege Tax — flat $5.75/mo employee + $4.00/mo
  // employer, gated on a $500/month threshold, verbatim from Denver's own
  // Tax Guide Topic 61 (fetched directly). This closes a real gap: CO-2026
  // .json's own $comment previously claimed "Denver is the only one wired
  // into calc code" when it genuinely wasn't (state.ts had no Denver
  // dispatch at all) — this describe block is the actual proof it's wired.
  describe('Denver Occupational Privilege Tax (OPT)', () => {
    test('at/above the $500/month threshold: both the $5.75 employee and $4.00 business OPT fire', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
          workState: {
            code: 'CO',
            certificate: { locality: 'Denver', denverMonthlyCompensation: dollars(3000) },
          },
        }),
      );
      assert.equal(amountOf(r, 'DENVER_OPT_EE'), dollars(5.75));
      assert.equal(amountOf(r, 'DENVER_OPT_ER'), dollars(4.0));
    });

    test('below the $500/month threshold: $0, not the flat amount', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
          workState: {
            code: 'CO',
            certificate: { locality: 'Denver', denverMonthlyCompensation: dollars(400) },
          },
        }),
      );
      assert.equal(amountOf(r, 'DENVER_OPT_EE'), 0);
      // Both lines report $0 explicitly (not omitted) — a below-threshold
      // employee owes neither the employee nor the employer OPT.
      assert.equal(amountOf(r, 'DENVER_OPT_ER'), 0);
    });

    test('exactly $500 meets the threshold (>=, not >)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
          workState: {
            code: 'CO',
            certificate: { locality: 'Denver', denverMonthlyCompensation: dollars(500) },
          },
        }),
      );
      assert.equal(amountOf(r, 'DENVER_OPT_EE'), dollars(5.75));
    });

    test('same-employer dedup (denverOPTWithheldThisMonth): $0 for BOTH the employee and employer OPT', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: {
            code: 'CO',
            certificate: {
              locality: 'Denver',
              denverMonthlyCompensation: dollars(2000),
              denverOPTWithheldThisMonth: true,
            },
          },
        }),
      );
      // This employer already paid both its own employee-side withholding
      // and its own Business OPT for this employee this month.
      assert.equal(amountOf(r, 'DENVER_OPT_EE'), 0);
      assert.equal(amountOf(r, 'DENVER_OPT_ER'), 0);
    });

    // Cross-employer coordination (Form TD269) — closed 2026-09-06. Found
    // while fixing this: the ONLY prior exemption flag zeroed BOTH lines,
    // which would have wrongly dropped a Business OPT this second employer
    // genuinely still owes. A separate flag keeps the two facts apart.
    describe('cross-employer coordination (Form TD269)', () => {
      test("localOPTEmployeeWithheldByOtherEmployer: employee OPT is $0, but this employer's own Business OPT still computes normally", () => {
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
            workState: {
              code: 'CO',
              certificate: {
                locality: 'Denver',
                denverMonthlyCompensation: dollars(2000),
                localOPTEmployeeWithheldByOtherEmployer: true,
              },
            },
          }),
        );
        assert.equal(amountOf(r, 'DENVER_OPT_EE'), 0);
        assert.equal(amountOf(r, 'DENVER_OPT_ER'), dollars(4.0));
      });

      test('flag not supplied: ordinary behavior (both lines charge normally), unchanged by this fix', () => {
        const r = calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
            workState: {
              code: 'CO',
              certificate: { locality: 'Denver', denverMonthlyCompensation: dollars(2000) },
            },
          }),
        );
        assert.equal(amountOf(r, 'DENVER_OPT_EE'), dollars(5.75));
        assert.equal(amountOf(r, 'DENVER_OPT_ER'), dollars(4.0));
      });
    });

    test('a non-Denver Colorado employee: no Denver OPT lines at all', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'CO' },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'DENVER_OPT_EE'), false);
      assert.equal(r.taxes.some((t) => t.id === 'DENVER_OPT_ER'), false);
    });
  });
});

describe('Utah', () => {
  // Reproduces ALL SIX of Publication 14's own worked examples exactly —
  // see utahWithholding()'s own doc comment for why the whole-dollar
  // rounding at lines 2 and 5 specifically (not just the final answer) is
  // what makes these match.
  const utState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'UT', certificate },
  });

  test('Example 1: weekly $400, single -> $12', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...utState({ maritalStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'UT_SIT'), dollars(12));
  });

  test('Example 2: biweekly $2,600, single -> $116 (allowance fully phased out to $0)', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2600) }],
        ...utState({ maritalStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'UT_SIT'), dollars(116));
  });

  test('Example 3: semimonthly $1,200, married -> $18', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1200) }],
        ...utState({ maritalStatus: 'married' }),
      }),
    );
    assert.equal(amountOf(r, 'UT_SIT'), dollars(18));
  });

  test('Example 4: monthly $7,800, married -> $347 (allowance fully phased out to $0)', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(7800) }],
        ...utState({ maritalStatus: 'married' }),
      }),
    );
    assert.equal(amountOf(r, 'UT_SIT'), dollars(347));
  });

  test('Example 5: quarterly $9,000, single -> $367 (line 2 rounds $400.50 up to $401)', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'quarterly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(9000) }],
        ...utState({ maritalStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'UT_SIT'), dollars(367));
  });

  test('Example 6: daily $175, married -> $5', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'daily',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(175) }],
        ...utState({ maritalStatus: 'married' }),
      }),
    );
    assert.equal(amountOf(r, 'UT_SIT'), dollars(5));
  });

  test('head of household folds into the single schedule, per Publication 14\'s own note', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
        ...utState({ maritalStatus: 'hoh' }),
      }),
    );
    assert.equal(amountOf(r, 'UT_SIT'), dollars(12));
  });

  test('a checkDate before 2026-06-01 uses the OLD 4.5% table (Rev. 4/25), not the current 4.45% one', () => {
    // Same biweekly $2,600/single as Example 2 above, but the OLD table's
    // own numbers ($117 base allowance, $350 threshold) produce a
    // genuinely different final answer than the current table's $116 —
    // proving this actually dispatches on checkDate, not just re-running
    // the same math with a different label. line2=2,600x4.5%=$117 exactly;
    // line4=2,600-350=2,250; line5=2,250x1.3%=$29.25->$29; line6=17-29,
    // floored at $0; withholding=117-0=$117.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-03-15',
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2600) }],
        ...utState({ maritalStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'UT_SIT'), dollars(117));
  });

  test('a checkDate on or after 2026-06-01 uses the current 4.45% table', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-01',
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2600) }],
        ...utState({ maritalStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'UT_SIT'), dollars(116));
  });

  test('an unrecognized maritalStatus throws rather than silently falling through to single', () => {
    assert.throws(
      () => calculatePaycheck(input(utState({ maritalStatus: 'divorced' }))),
      /Unrecognized UT certificate\.maritalStatus/,
    );
  });
});

describe('Maryland', () => {
  // No official worked example with a stated dollar answer was found in
  // the 2026 guide the way California/Rhode Island's own sources
  // provided, so these fixtures are hand-derived from the guide's own
  // formula (state bracket + county rate, both on the same taxable
  // income) — but the STATE+LOCAL COMBINATION logic itself was verified
  // separately first: reconstructing state brackets 4-10 (4.75/5.00/5.25/
  // 5.50/5.75/6.25/6.50%) each plus the guide's own published "2.25%
  // local" table reproduces its stated combined rates (7.00/7.25/7.50/
  // 7.75/8.00/8.50/8.75%) exactly, 7-for-7, before any of this was
  // written into a test.
  // Withholding starts at 4.75% on the first dollar ('Maryland law does
  // not permit the use of a rate of less than 4.75% to be used for
  // withholding tax purposes' -- Withholding Tax Facts 2026), so each state
  // figure below is $52.50 above the return schedule's $90 + 4.75% form.
  const mdState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'MD', certificate },
  });

  test('Worcester County (flat 2.25%), single, 0 exemptions, annual $80,000', () => {
    // Taxable: 80,000 - 3,400 = 76,600. State (single, bracket [3,000-
    // 100,000], base $90, 4.75%): 90 + 4.75%x73,600 = 90+3,496=3,586.00.
    // Local (Worcester 2.25% flat): 76,600 x 2.25% = 1,723.50. Combined:
    // 3,586.00 + 1,723.50 = 5,309.50.
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(80000) }],
        ...mdState({ filingStatus: 'single', exemptions: 0, county: 'Worcester' }),
      }),
    );
    assert.equal(amountOf(r, 'MD_SIT'), dollars(5362));
  });

  test('Anne Arundel County (TIERED local rate), MFJ/HOH, 2 exemptions, annual $120,000', () => {
    // Taxable: 120,000 - 3,400 - 2x3,200 = 110,200. State (mfjHoh, bracket
    // [3,000-150,000], base $90, 4.75%): 90+4.75%x107,200=90+5,092=5,182.00.
    // Local (Anne Arundel mfjHoh tiered, [75,000-480,000], base $2,025,
    // 2.94%): 2,025+2.94%x35,200=2,025+1,034.88=3,059.88. Combined:
    // 5,182.00+3,059.88=8,241.88.
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(120000) }],
        ...mdState({ filingStatus: 'mfjHoh', exemptions: 2, county: 'AnneArundel' }),
      }),
    );
    assert.equal(amountOf(r, 'MD_SIT'), dollars(8294.38));
  });

  test('Frederick County (TIERED local rate), single, 1 exemption, annual $60,000', () => {
    // Taxable: 60,000-3,400-3,200=53,400. State: same bracket as above,
    // 90+4.75%x50,400=90+2,394=2,484.00. Local (Frederick single tiered,
    // [50,000-150,000], base $1,250, 2.96%): 1,250+2.96%x3,400=1,250+
    // 100.64=1,350.64. Combined: 2,484.00+1,350.64=3,834.64.
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(60000) }],
        ...mdState({ filingStatus: 'single', exemptions: 1, county: 'Frederick' }),
      }),
    );
    assert.equal(amountOf(r, 'MD_SIT'), dollars(3887.14));
  });

  test('no certificate at all defaults to the maximum 3.30% local rate', () => {
    // Same $80,000/single/0-exemption base as the Worcester test, but the
    // no-cert default local rate (3.30%) instead of Worcester's 2.25%:
    // 76,600 x 3.30% = 2,527.80. Combined: 3,586.00+2,527.80=6,113.80.
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(80000) }],
        workState: { code: 'MD' },
      }),
    );
    assert.equal(amountOf(r, 'MD_SIT'), dollars(6166.3));
  });

  test('nonresident uses the flat 2.25% Special Nonresident Rate, not a county lookup', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(80000) }],
        ...mdState({ filingStatus: 'single', exemptions: 0, nonresident: true }),
      }),
    );
    // Same figure as the Worcester test (2.25% happens to match Worcester's
    // own flat rate) -- confirms the nonresident PATH itself is exercised
    // and produces the correct combined amount, not that the two are
    // indistinguishable in general.
    assert.equal(amountOf(r, 'MD_SIT'), dollars(5362));
  });

  test('certificate.nonresident as the STRING "false" throws instead of silently switching to the nonresident rate', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'annual',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(80000) }],
            ...mdState({ filingStatus: 'single', exemptions: 0, nonresident: 'false' }),
          }),
        ),
      /Unrecognized certificate\.nonresident/,
    );
  });

  test('reciprocity: a Pennsylvania resident working in Maryland owes $0 MD tax', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(80000) }],
        ...mdState({ filingStatus: 'single', exemptions: 0, county: 'Worcester' }),
        residenceState: { code: 'PA' },
      }),
    );
    assert.equal(amountOf(r, 'MD_SIT'), 0);
  });

  // The Employer Withholding Guide's own "Lump Sum Distribution of Annual
  // Bonus" rule: 6.50% (the state's own top rate) plus the county's own
  // highest local rate, flat, in place of the ordinary combined bracket —
  // an employer election, gated on the bonus being the whole cheque.
  describe('Lump sum bonus withholding', () => {
    test('Allegany (flat 3.20% local): a standalone $10,000 bonus withholds exactly 9.70% (6.50% + 3.20%)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(10000) }],
          ...mdState({ county: 'Allegany' }),
          employer: { supplementalFlatRateElection: { MD: true } },
        }),
      );
      assert.equal(amountOf(r, 'MD_SIT_SUPP'), dollars(970.0));
    });

    test('BUG FIX: a pretax deduction on a bonus-only cheque reduces the taxable base', () => {
      // $10,000 bonus (the whole cheque), $3,000 401(k) deferral. Before
      // this fix, the carve-out ignored pretax entirely — the deferral
      // vanished and the full $10,000 was taxed. Correct: 10,000-3,000 =
      // $7,000 @ 9.70% = $679.00, not $970.00.
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(10000) }],
          deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(3000) }],
          ...mdState({ county: 'Allegany' }),
          employer: { supplementalFlatRateElection: { MD: true } },
        }),
      );
      assert.equal(amountOf(r, 'MD_SIT_SUPP'), dollars(679.0));
    });

    test('Anne Arundel (tiered local): the lump-sum rate uses the TOP of the tiered schedule (3.20%), same 9.70% combined', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(10000) }],
          ...mdState({ county: 'AnneArundel' }),
          employer: { supplementalFlatRateElection: { MD: true } },
        }),
      );
      assert.equal(amountOf(r, 'MD_SIT_SUPP'), dollars(970.0));
    });

    test('a different county (Worcester, 2.25% local) gets a different combined rate: 8.75%', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(10000) }],
          ...mdState({ county: 'Worcester' }),
          employer: { supplementalFlatRateElection: { MD: true } },
        }),
      );
      assert.equal(amountOf(r, 'MD_SIT_SUPP'), dollars(875.0));
    });

    test('without the employer election, no flat line fires — falls back to the ordinary annual formula', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(10000) }],
          ...mdState({ county: 'Allegany' }),
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'MD_SIT_SUPP'), false);
      assert.ok(amountOf(r, 'MD_SIT') > 0);
    });

    test('a nonresident never gets the flat lump-sum rate, even if the employer elected it', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(10000) }],
          ...mdState({ nonresident: true }),
          employer: { supplementalFlatRateElection: { MD: true } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'MD_SIT_SUPP'), false);
    });

    test('a bonus paid alongside regular wages runs through the ordinary combined formula, never the flat rate', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [
            { code: 'REG', category: 'regular', amount: dollars(3000) },
            { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
          ],
          ...mdState({ county: 'Allegany' }),
          employer: { supplementalFlatRateElection: { MD: true } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'MD_SIT_SUPP'), false);
      const combined = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(4000) }],
          ...mdState({ county: 'Allegany' }),
        }),
      );
      assert.equal(amountOf(r, 'MD_SIT'), amountOf(combined, 'MD_SIT'));
    });
  });

  test('an unrecognized filingStatus throws rather than silently falling through to single', () => {
    assert.throws(
      () => calculatePaycheck(input(mdState({ filingStatus: 'divorced', county: 'Worcester' }))),
      /Unrecognized MD certificate\.filingStatus/,
    );
  });
});

describe('Rhode Island', () => {
  const riState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'RI', certificate },
  });

  test("reproduces the booklet's own worked example: weekly $2,195, 1 exemption -> $87.57", () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2195) }],
        ...riState({ exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'RI_SIT'), dollars(87.57));
  });

  test('exemption phases out entirely (a cliff) once weekly wages exceed $5,592.31', () => {
    // Weekly $6,000, 2 exemptions -- wages exceed the $5,592.31 weekly
    // threshold, so the exemption is $0 despite 2 being claimed. Net =
    // $6,000, bracket [3,586-inf, base $154.56, 5.99%]: 154.56 +
    // 5.99%x2,414 = 154.56+144.60=299.16.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(6000) }],
        ...riState({ exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'RI_SIT'), dollars(299.16));
  });

  test('TDI: $1,000 x 1.1%', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        workState: { code: 'RI' },
      }),
    );
    assert.equal(amountOf(r, 'RI_DBL_EE'), dollars(11));
  });

  test('no reciprocity: a Massachusetts resident working in RI still owes ordinary RI withholding', () => {
    const withMA = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2195) }],
        ...riState({ exemptions: 1 }),
        residenceState: { code: 'MA' },
      }),
    );
    assert.equal(amountOf(withMA, 'RI_SIT'), dollars(87.57));
  });
});

describe('District of Columbia', () => {
  const dcState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'DC', certificate },
  });

  test('annual $50,000, 1 allowance', () => {
    // Taxable: 50,000-4,300=45,700. Bracket [40,000-60,000, base $2,200,
    // 6.5%]: 2,200+6.5%x5,700=2,200+370.50=2,570.50.
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(50000) }],
        ...dcState({ allowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'DC_SIT'), dollars(2570.5));
  });

  test('biweekly $2,000, 0 allowances', () => {
    // Annual 2,000x26=52,000. Bracket [40,000-60,000, base $2,200, 6.5%]:
    // 2,200+6.5%x12,000=2,200+780=2,980.00/yr / 26 = 114.6153... -> $114.62.
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        workState: { code: 'DC' },
      }),
    );
    assert.equal(amountOf(r, 'DC_SIT'), dollars(114.62));
  });

  test('DC does not tax nonresident wages at all (Home Rule Act), regardless of residence state', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200000) }],
        ...dcState({ nonresident: true }),
      }),
    );
    assert.equal(amountOf(r, 'DC_SIT'), 0);
  });

  test('certificate.nonresident as the STRING "false" throws instead of silently zeroing a real DC resident\'s tax', () => {
    // The real risk this guards against: DC's own no-nonresident-tax rule
    // makes this a genuinely dangerous field to get wrong in this
    // direction — a true DC resident, wrongly read as nonresident, would
    // have their entire DC withholding silently zeroed.
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'annual',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(200000) }],
            ...dcState({ nonresident: 'false' }),
          }),
        ),
      /Unrecognized certificate\.nonresident/,
    );
  });
});

describe('Virginia', () => {
  // VA was built to calc-code specifically to unblock proving PA
  // reciprocity's outbound direction through the real engine (VA-2026.json
  // was previously data-only). Expected values hand-derived from the
  // Income Tax Withholding Guide's own formula before running, same
  // discipline as every other state here.
  const vaState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'VA', certificate },
  });

  test("reproduces the Guide's own worked example to the cent: semimonthly $2,649, 5 personal exemptions", () => {
    // A = 2,649 x 24 = 63,576. T = 63,576 - [8,750 + 5x930] = 50,176.
    // Over $17,000: 720 + 5.75%x(50,176-17,000=33,176) = 720 + 1,907.62,
    // rounded to the nearest WHOLE DOLLAR before adding (the Guide's own
    // non-obvious step) = 720 + 1,908 = 2,628/yr / 24 = $109.50/period.
    const r = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2649) }],
        ...vaState({ personalExemptions: 5 }),
      }),
    );
    assert.equal(amountOf(r, 'VA_SIT'), dollars(109.5));
  });

  test('the age/blind exemption (E2, $800) is tracked separately from the personal exemption (E1, $930)', () => {
    // Annual $50,000, 0 personal + 1 age/blind exemption.
    // T = 50,000 - [8,750 + 0 + 1x800] = 40,450. Over $17,000: 720 +
    // 5.75%x(40,450-17,000=23,450) = 720 + 1,348.375 -> rounds to 1,348
    // = $2,068.00/yr (annual frequency, no further division).
    const r = calculatePaycheck(
      input({
        payFrequency: 'annual',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(50000) }],
        ...vaState({ ageOrBlindExemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'VA_SIT'), dollars(2068.0));
  });

  test('reciprocity: PA/MD/WV residents owe $0 VA tax unconditionally', () => {
    for (const code of ['PA', 'MD', 'WV']) {
      const r = calculatePaycheck(
        input({
          payFrequency: 'semimonthly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(2649) }],
          residenceState: { code },
          ...vaState({ personalExemptions: 5 }),
        }),
      );
      assert.equal(amountOf(r, 'VA_SIT'), 0, `expected $0 VA tax for a ${code} resident`);
    }
  });

  test("reciprocity's KY/DC commuter gate: a daily commuter owes $0, a non-commuter owes full VA tax", () => {
    // This is the bug VA-4's own narrowerCommuterException field already
    // documented — before this pass, KY/DC weren't even in VA's own
    // reciprocalStates array, so the commuter gate could never fire at all
    // (reciprocityExemptionReason() checks reciprocalStates FIRST). Now
    // wired end-to-end.
    const commuter = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2649) }],
        residenceState: { code: 'KY', certificate: { dailyCommuter: true } },
        ...vaState({ personalExemptions: 5 }),
      }),
    );
    assert.equal(amountOf(commuter, 'VA_SIT'), 0);

    const nonCommuter = calculatePaycheck(
      input({
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2649) }],
        residenceState: { code: 'KY' },
        ...vaState({ personalExemptions: 5 }),
      }),
    );
    assert.equal(amountOf(nonCommuter, 'VA_SIT'), dollars(109.5));
  });
});

describe('West Virginia', () => {
  // WV was built to calc-code alongside VA, same motivation. Uses genuine
  // per-period tables (no annualize/divide) — hand-derived independently
  // from IT-100.2A's own weekly table before running.
  const wvState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'WV', certificate },
  });

  test('weekly $800, 1 exemption, default Two Earner table: $24', () => {
    // Taxable = 800 - 38.46 = 761.54. Bracket [577-866, base 15.95, 4.22%]:
    // 15.95 + 4.22%x(761.54-577=184.54) = 15.95 + 7.79 = $23.74, rounded
    // to the nearest whole dollar per IT-100.1-A = $24.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
        ...wvState({ exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'WV_SIT'), dollars(24));
  });

  test('weekly $800, 1 exemption, One Earner/One Job elected (IT-104 Line 5): $21', () => {
    // Same taxable $761.54, but the ONE-EARNER table's bracket [481-769,
    // base 12.17, 3.16%] applies instead: 12.17 + 3.16%x(761.54-481=280.54)
    // = 12.17 + 8.87 = $21.04 — less withheld than the default table, as
    // expected (opting in is only available to single filers/one-job
    // households, and produces LOWER withholding, per IT-104's own design).
    // Rounded to the nearest whole dollar per IT-100.1-A = $21.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
        ...wvState({ exemptions: 1, oneEarnerElection: true }),
      }),
    );
    assert.equal(amountOf(r, 'WV_SIT'), dollars(21));
  });

  test('no certificate on file defaults to 0 exemptions and the (higher-withholding) Two Earner table: $25', () => {
    // Taxable = 800 - 0 = 800. Bracket [577-866, base 15.95, 4.22%]:
    // 15.95 + 4.22%x(800-577=223) = 15.95 + 9.41 = $25.36 -> $25 (IT-100.1-A
    // nearest-whole-dollar rule).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
        workState: { code: 'WV' },
      }),
    );
    assert.equal(amountOf(r, 'WV_SIT'), dollars(25));
  });

  test('reciprocity: a Pennsylvania resident working in West Virginia owes $0 WV tax', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
        residenceState: { code: 'PA' },
        ...wvState({ exemptions: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'WV_SIT'), 0);
  });

  // Municipal Service Fee (WV_LOCAL_FEE) — a flat PER-WEEK fee, genuinely
  // different from every bracket/percentage tax elsewhere in this file.
  // Amounts hand-derived from each city's own published weekly rate
  // (WV-2026.json's own serviceFeeCities) before running.
  describe('Municipal Service Fee (WV_LOCAL_FEE)', () => {
    test('Charleston, weekly pay: the weekly rate applies directly ($3.00/wk x 52 / 52 periods)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Charleston' } },
        }),
      );
      // Corrected 2026-09-06: Charleston's own City Service Fee Overview PDF
      // (charlestonwv.gov) states $3.00/wk, not the $2.50 this file carried
      // before — see WV-2026.json's charlestonRateCorrection note.
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(3.0));
    });

    test('Wheeling, biweekly pay: $2.00/wk x 52 / 26 periods = $4.00/period', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
          workState: { code: 'WV', certificate: { locality: 'Wheeling' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(4.0));
    });

    test('Weirton, monthly pay, check date on/after the 2026-05-14 rate increase: $5.00/wk x 52 / 12 periods = $21.6666, rounded DOWN to $21.66', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'monthly',
          checkDate: '2026-05-14',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(4000) }],
          workState: { code: 'WV', certificate: { locality: 'Weirton' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(21.66));
    });

    test('Weirton, monthly pay, check date BEFORE the 2026-05-14 rate increase: pre-ordinance $2.00/wk applies instead', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'monthly',
          checkDate: '2026-05-13',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(4000) }],
          workState: { code: 'WV', certificate: { locality: 'Weirton' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(8.66));
    });

    test('no certificate.locality: no WV_LOCAL_FEE line at all', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV' },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'WV_LOCAL_FEE'), false);
    });

    test('a WV city with no service fee (not one of the 11 captured): no WV_LOCAL_FEE line', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Beckley' } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'WV_LOCAL_FEE'), false);
    });

    test('Madison, weekly pay: work-location-based like Wheeling, no residency exception ($3.00/wk)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Madison' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(3.0));
    });

    test('Fairmont, non-resident duty station: nonResidentOnly city still charges a nonresident ($2.00/wk)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Fairmont', residenceCity: 'Clarksburg' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(2.0));
    });

    test('Fairmont, resident duty station: Ordinance 1812 bills residents directly, not via payroll — no WV_LOCAL_FEE line', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Fairmont', residenceCity: 'Fairmont' } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'WV_LOCAL_FEE'), false);
    });

    test('Fairmont, no residenceCity supplied: defaults to nonresident treatment (charged, same as any other duty-station-only city)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Fairmont' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(2.0));
    });

    test('Romney, non-resident duty station: nonResidentOnly city charges a nonresident ($1.00/wk)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Romney', residenceCity: 'Petersburg' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(1.0));
    });

    test('Romney, resident duty station: ordinance Section 5 excludes residents paying the City user fee — no WV_LOCAL_FEE line', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Romney', residenceCity: 'Romney' } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'WV_LOCAL_FEE'), false);
    });

    test('Glen Dale, weekly pay: work-location-based like Wheeling/Madison, no residency exception ($1.00/wk, Article 752 effective 2025-01-01)', () => {
  });

    test('Glen Dale, resident duty station: Article 752 has no residency carve-out, so a resident is charged too ($1.00/wk)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Glen Dale' } },
          workState: { code: 'WV', certificate: { locality: 'Glen Dale', residenceCity: 'Glen Dale' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(1.0));
    });

    test('Montgomery, weekly pay: work-location-based, no residency exception ($2.00/wk, the 2021-07-01 step of the phased-in schedule)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Montgomery' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(2.0));
    });

    // Three formerly-disclosed-but-unmodelled gaps, closed 2026-09-06.

    test('Weirton, check date BEFORE the 2026-05-14 ordinance effective date: prior $2.00/wk rate applies, not the current $5.00', () => {
      const r = calculatePaycheck(
        input({
          checkDate: '2026-03-01',
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Weirton' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(2.0));
    });

    test('Weirton, check date on the effective date itself: new $5.00/wk rate applies', () => {
      const r = calculatePaycheck(
        input({
          checkDate: '2026-05-14',
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Weirton' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(5.0));
    });

    test('Wheeling, daysWorkedInLocality below the 30-day threshold: fee has not attached yet, no WV_LOCAL_FEE line', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Wheeling', daysWorkedInLocality: 10 } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'WV_LOCAL_FEE'), false);
    });

    test('Wheeling, daysWorkedInLocality at the 30-day threshold: fee attaches ($2.00/wk)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Wheeling', daysWorkedInLocality: 30 } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(2.0));
    });

    test('Wheeling, daysWorkedInLocality not supplied: defaults to already-past-threshold (unchanged pre-fix behavior, $2.00/wk)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Wheeling' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(2.0));
    });

    test('Glen Dale, daysWorkedInLocality below its 30-day-per-year threshold: no WV_LOCAL_FEE line', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Glen Dale', daysWorkedInLocality: 5 } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'WV_LOCAL_FEE'), false);
    });

    test('multi-job dedup: certificate.wvLocalFeeAlreadyWithheld skips a second employer\'s withholding in the same city', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: {
            code: 'WV',
            certificate: { locality: 'Charleston', wvLocalFeeAlreadyWithheld: true },
          },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'WV_LOCAL_FEE'), false);
    });

    test('multi-job dedup: wvLocalFeeAlreadyWithheld not supplied still charges normally ($3.00/wk)', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(800) }],
          workState: { code: 'WV', certificate: { locality: 'Charleston' } },
        }),
      );
      assert.equal(amountOf(r, 'WV_LOCAL_FEE'), dollars(3.0));
    });
  });

  describe('supplemental wages (annual-marginal method, Withholding Help page)', () => {
    test('standalone bonus with prior regular payment: withheld at IT-100.2A\'s own top marginal rate (4.58%)', () => {
      // Withholding Help's own worked example: biweekly $2,000 regular +
      // $5,000 standalone bonus. The page's OWN PROSE states the bonus
      // withholds at 4.82% — this implementation, grounded directly in
      // IT-100.2A's own published annual bracket table, produces 4.58%
      // (IT-100.2A's own top marginal rate) instead. That 24-basis-point
      // gap is a DISCLOSED, unresolved discrepancy against the state's own
      // prose (see westVirginiaSupplementalAnnualMarginal()'s doc comment
      // for the full reasoning) — not a rounding artifact, and not
      // silently assumed away. $52,000/yr regular alone -> $1,783.48 tax;
      // $57,000/yr combined -> $2,012.48 tax; difference = $229.00 =
      // exactly 4.58% of the $5,000 bonus.
      const regular = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
          workState: { code: 'WV', certificate: {} },
        }),
      );
      // $68.59 before IT-100.1-A's nearest-whole-dollar rounding.
      assert.equal(amountOf(regular, 'WV_SIT'), dollars(69));

      const bonus = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(5000) }],
          workState: { code: 'WV', certificate: {} },
          priorRegularPayment: {
            taxableWages: dollars(2000),
            stateIncomeTaxWithheld: amountOf(regular, 'WV_SIT'),
          },
        }),
      );
      assert.equal(amountOf(bonus, 'WV_SIT'), dollars(229));
    });

    test('standalone bonus with NO prior-payment context: falls back to the ordinary per-period formula rather than throwing', () => {
      const bonus = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(5000) }],
          workState: { code: 'WV', certificate: {} },
        }),
      );
      assert.ok(amountOf(bonus, 'WV_SIT') > 0);
    });

    test('a bonus paid ALONGSIDE regular wages on the same cheque uses the ordinary per-cheque table, not the annual-marginal split', () => {
      const combined = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [
            { code: 'REG', category: 'regular', amount: dollars(2000) },
            { code: 'BONUS', category: 'supplemental', amount: dollars(5000) },
          ],
          workState: { code: 'WV', certificate: {} },
          priorRegularPayment: { taxableWages: dollars(2000), stateIncomeTaxWithheld: dollars(68.59) },
        }),
      );
      const plain = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(7000) }],
          workState: { code: 'WV', certificate: {} },
        }),
      );
      assert.equal(amountOf(combined, 'WV_SIT'), amountOf(plain, 'WV_SIT'));
    });
  });
});

describe('North Carolina', () => {
  const ncState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'NC', certificate },
  });

  test('weekly $1,000, Single/Married, 1 allowance: $29', () => {
    // Annual 1,000x52=52,000. Less $12,750 standard deduction, less
    // 1x$2,500 allowance = $36,750 taxable. x4.09% = $1,503.08/yr (cent-
    // rounded) / 52 = $28.91 -> rounds to the nearest WHOLE DOLLAR ($29),
    // per NC-30's own explicit rounding instruction.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ncState({ allowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'NC_SIT'), dollars(29));
  });

  test('weekly $1,000, Head of Household, 0 allowances: $26', () => {
    // Annual 52,000 less the HIGHER $19,125 HoH standard deduction (no
    // separate Married table exists in NC's formula -- this is the ONLY
    // status split) = $32,875 taxable. x4.09% = $1,344.59/yr / 52 =
    // $25.86 -> rounds to $26.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...ncState({ filingStatus: 'head_of_household' }),
      }),
    );
    assert.equal(amountOf(r, 'NC_SIT'), dollars(26));
  });

  test('no reciprocity with any state', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        residenceState: { code: 'VA' },
        ...ncState({ allowances: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'NC_SIT'), dollars(29));
  });

  describe('certificate.nonresidentAlien (NC-4 NRA, NC-30 §13)', () => {
    // NC-30 §13's own published additional-withholding chart, reproduced
    // exactly at $0 wages (isolating the add-on from the ordinary formula):
    // weekly $11, biweekly $21, semimonthly $22, monthly $44.
    const cases: [string, number][] = [
      ['weekly', 11],
      ['biweekly', 21],
      ['semimonthly', 22],
      ['monthly', 44],
    ];
    for (const [payFrequency, expected] of cases) {
      test(`${payFrequency}, $0 wages: exactly NC-30's published add-on of $${expected}`, () => {
        const r = calculatePaycheck(
          input({
            payFrequency: payFrequency as PaycheckInput['payFrequency'],
            earnings: [{ code: 'REG', category: 'regular', amount: 0 }],
            ...ncState({ nonresidentAlien: true }),
          }),
        );
        assert.equal(amountOf(r, 'NC_SIT'), dollars(expected));
      });
    }

    test('BUG FIX: nonresidentAlien: "false" (a string) throws rather than being silently treated as true', () => {
      // Same class of bug already guarded against on certificate.exempt and
      // certificate.nonresident (see resolveCertBoolean's own doc comment):
      // this file's own line 8035 used to read Boolean(cert.nonresidentAlien)
      // directly, which the guard function's OWN doc comment already named
      // as the specific anti-pattern that doesn't work — Boolean("false") is
      // true. Closed the same session this table was written, across all 4
      // call sites (Minnesota, Idaho x2, North Carolina).
      assert.throws(
        () =>
          calculatePaycheck(
            input({
              payFrequency: 'monthly',
              earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
              ...ncState({ nonresidentAlien: 'false' }),
            }),
          ),
        /Unrecognized certificate\.nonresidentAlien/,
      );
    });

    test('forces Single status and 0 allowances even if the certificate claims otherwise', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'monthly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
          ...ncState({ nonresidentAlien: true, filingStatus: 'head_of_household', allowances: 3 }),
        }),
      );
      // $60,000/yr less $12,750 (forced Single deduction, NOT the $19,125
      // HoH figure) less $0 (forced 0 allowances) = $47,250 taxable x
      // 4.09% = $1,932.53/yr / 12 = $161.04 -> $161 (whole-dollar round),
      // plus the $44 monthly add-on = $205.
      assert.equal(amountOf(r, 'NC_SIT'), dollars(205));
    });

    test('without the flag, an otherwise-identical employee is NOT charged the add-on', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'monthly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
          ...ncState({ allowances: 0 }),
        }),
      );
      assert.equal(amountOf(r, 'NC_SIT'), dollars(161));
    });
  });
});

describe('South Carolina', () => {
  const scState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'SC', certificate },
  });

  test("reproduces WH-1603F's own worked example exactly: weekly $750, 3 allowances -> $10.58", () => {
    // Annual 750x52=39,000. Personal allowance 3x$5,000=$15,000. Standard
    // deduction 10%x39,000=$3,900 (under the $7,500 cap). Taxable
    // $20,100. Bracket 3 (>=$18,230): $437.70 + 6%x($20,100-18,230=1,870
    // =$112.20) = $549.90/yr / 52 = $10.5750 -> $10.58/week. No
    // whole-dollar rounding in South Carolina, unlike NC/VA.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(750) }],
        ...scState({ allowances: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'SC_SIT'), dollars(10.58));
  });

  test('0 allowances forfeits BOTH the personal allowance AND the standard deduction at once', () => {
    // Annual 500x52=26,000, NO deductions at all (the all-or-nothing
    // quirk WH-1603F's own text confirms). Bracket 3: $437.70 +
    // 6%x(26,000-18,230=7,770=$466.20) = $903.90/yr / 52 = $17.3827 ->
    // $17.38/week.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        workState: { code: 'SC' },
      }),
    );
    assert.equal(amountOf(r, 'SC_SIT'), dollars(17.38));
  });

  test('no reciprocity with any state', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(750) }],
        residenceState: { code: 'NC' },
        ...scState({ allowances: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'SC_SIT'), dollars(10.58));
  });
});

describe('Arkansas', () => {
  const arState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'AR', certificate },
  });

  test("reproduces the Formula Method's own worked example exactly: monthly $2,127, 2 exemptions -> $36.50", () => {
    // Annual 2,127x12=25,524, less $2,470 standard deduction = $23,054
    // net taxable. Midrange-rounded to $23,050 (nearest $50 of the
    // $23,000-$23,100 band). Bracket [$16,000-$26,400, 3.4%, adjustment
    // $287.97]: 23,050x3.4%=$783.70, less $287.97 = $495.73, ROUNDED to
    // $496.00 (a genuine mid-formula whole-dollar step). Less $58.00
    // credit (2x$29) = $438.00 annual net tax / 12 = $36.50.
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2127) }],
        ...arState({ exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'AR_SIT'), dollars(36.5));
  });

  test('$50-midrange rounding applies at low income too, not just the top phase-in zone: weekly $200, 0 exemptions -> $0.90', () => {
    // Annual 200x52=10,400, less $2,470 = $7,930 net taxable. Midrange-
    // rounded to $7,950. Bracket [$5,600-$11,200, 2%, adjustment
    // $111.98]: 7,950x2%=$159.00, less $111.98 = $47.02, rounds to
    // $47.00. No exemptions, so annual net tax stays $47.00 / 52 = $0.90.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
        workState: { code: 'AR' },
      }),
    );
    assert.equal(amountOf(r, 'AR_SIT'), dollars(0.9));
  });

  test('HB 1001 (2026) cut the top rate to 3.7%, retroactive to Jan 1 — matches PaycheckCity: biweekly $8,492.31 -> $307.62, monthly $7,133.33 -> $225.75', () => {
    // Biweekly: 8,492.31 x 26 = 220,800.06, less $2,470 = $218,330.06 (over
    // $100,001, so no midrange rounding) x 3.7% = $8,078.21, less $79.90 =
    // $7,998.31 -> $7,998 / 26 = $307.62. Under the superseded 3.9% table
    // this was $324.08.
    const biweekly = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(8492.31) }],
        workState: { code: 'AR' },
      }),
    );
    assert.equal(amountOf(biweekly, 'AR_SIT'), dollars(307.62));
    // Monthly: 7,133.33 x 12 = 85,599.96, less $2,470 = $83,129.96 ->
    // midrange $83,150 x 3.7% = $3,076.55, less $367.16 = $2,709.39 ->
    // $2,709 / 12 = $225.75.
    const monthly = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(7133.33) }],
        workState: { code: 'AR' },
      }),
    );
    assert.equal(amountOf(monthly, 'AR_SIT'), dollars(225.75));
  });

  test('no reciprocity with any state', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2127) }],
        residenceState: { code: 'TN' },
        ...arState({ exemptions: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'AR_SIT'), dollars(36.5));
  });
});

describe('Alabama', () => {
  // Alabama's own formula subtracts the employee's ANNUAL FEDERAL
  // WITHHOLDING as a deduction component -- this describe block isolates
  // the AL-only math with a federal-exempt certificate first, then proves
  // the cross-tax dependency actually wires through separately.
  test("reproduces the withholding booklet's own worked example structure: weekly $850, 'M-2', federal exempt -> $31.35", () => {
    // GI = 850x52 = $44,200. Standard deduction (MFJ, GI >= $35,500
    // ceiling): floor $5,000. Personal exemption (M): $3,000. 2
    // dependents x $1,000 (GI <= $50,000 tier) = $2,000. Federal
    // withholding = $0 (exempt, isolating AL-only math from the booklet's
    // own stale example federal figure). Total deductions = $10,000.
    // Taxable = $34,200. Married bracket [$6,000+, base $220, 5%]:
    // 220 + 5%x(34,200-6,000=28,200=$1,410) = $1,630.00/yr / 52 = $31.35.
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(850) }],
        workState: { code: 'AL', certificate: { alabamaExemptionCode: 'M', dependents: 2 } },
        federalW4: {
          filingStatus: 'married_joint',
          multipleJobs: false,
          dependentCredit: 0,
          otherIncome: 0,
          deductions: 0,
          extraWithholding: 0,
          exempt: true,
        },
      }),
    );
    assert.equal(amountOf(r, 'AL_SIT'), dollars(31.35));
  });

  test('federal withholding actually reduces the AL taxable base (cross-tax dependency wired through)', () => {
    const fixture = {
      payFrequency: 'weekly' as const,
      earnings: [{ code: 'REG', category: 'regular', amount: dollars(850) }],
      workState: {
        code: 'AL',
        certificate: { alabamaExemptionCode: 'M', dependents: 2 },
      },
    };
    const withFederalExempt = calculatePaycheck(
      input({
        ...fixture,
        federalW4: {
          filingStatus: 'married_joint',
          multipleJobs: false,
          dependentCredit: 0,
          otherIncome: 0,
          deductions: 0,
          extraWithholding: 0,
          exempt: true,
        },
      }),
    );
    const withRealFederal = calculatePaycheck(input(fixture)); // default federalW4, not exempt
    const federalWithheld = amountOf(withRealFederal, 'US_FIT');
    assert.ok(federalWithheld > 0, 'fixture must actually produce nonzero federal withholding to test this');
    assert.ok(
      amountOf(withRealFederal, 'AL_SIT') < amountOf(withFederalExempt, 'AL_SIT'),
      'more federal withholding should mean less AL taxable income, and therefore less AL tax',
    );
  });

  test('the standard deduction step function matches the booklet\'s own Schedule table for Single status', () => {
    // Single/"0", GI = $26,000 (weekly $500 x 52) -- $1 above the $25,999
    // threshold, which the booklet's own table shows still rounds UP to
    // ONE full $500 increment: $3,000 - $25 = $2,975 standard deduction.
    // Personal exemption $0 ("0" code). No dependents, no federal
    // withholding (exempt).
    const r = calculatePaycheck(
      input({
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        workState: { code: 'AL', certificate: { alabamaExemptionCode: '0' } },
        federalW4: {
          filingStatus: 'single',
          multipleJobs: false,
          dependentCredit: 0,
          otherIncome: 0,
          deductions: 0,
          extraWithholding: 0,
          exempt: true,
        },
      }),
    );
    // Taxable = 26,000 - 2,975 = 23,025. Non-married bracket
    // [$3,000+, base $110, 5%]: 110 + 5%x(23,025-3,000=20,025=$1,001.25)
    // = $1,111.25/yr / 52 = $21.37 (roundHalfUp of 21.370192...).
    assert.equal(amountOf(r, 'AL_SIT'), dollars(21.37));
  });

  test('BUG FIX: an unrecognized alabamaExemptionCode throws rather than silently defaulting to single', () => {
    // resolveALDeductionKey() and alabamaPersonalExemption() used to fall
    // through to the single/'0' case for ANY code they didn't explicitly
    // recognize, not just '0'/'S' — a typo'd code (e.g. 'Mrs' instead of
    // 'M', or a copy-pasted field from a different state) would have
    // silently under-withheld a married or head-of-family employee as a
    // single filer, with no error. Same anti-pattern this project's own
    // Arizona electedRate fix already closed for a different field.
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
            workState: { code: 'AL', certificate: { alabamaExemptionCode: 'Mrs' } },
          }),
        ),
      /Unrecognized AL certificate\.alabamaExemptionCode/,
    );
  });

  // Municipal Occupational Tax (AL_LOCAL) — sourced from the Alabama
  // League of Municipalities' own tax-rate survey (data/local/
  // AL-municipalities-2026.json), work-location-based, no resident/
  // nonresident split. Rates used below are real, taken directly from
  // that file: Birmingham 1%, Gadsden 2%.
  describe('Municipal Occupational Tax (AL_LOCAL)', () => {
    test('Birmingham: 1% of wages earned there', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'AL', certificate: { workCity: 'Birmingham' } },
        }),
      );
      assert.equal(amountOf(r, 'AL_LOCAL'), dollars(10.0));
    });

    test('Gadsden: a different city, a different (higher) rate — 2%', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'AL', certificate: { workCity: 'Gadsden' } },
        }),
      );
      assert.equal(amountOf(r, 'AL_LOCAL'), dollars(20.0));
    });

    test('no certificate.workCity: no AL_LOCAL line at all', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'AL' },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'AL_LOCAL'), false);
    });

    test('a city not among the 25 known taxing municipalities: no AL_LOCAL line, not a silent $0 assumption', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'AL', certificate: { workCity: 'Montgomery' } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'AL_LOCAL'), false);
    });

    test('Hackleburg resolves via its alias even though the source data spells it "Hacklebug"', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
          workState: { code: 'AL', certificate: { workCity: 'Hackleburg' } },
        }),
      );
      assert.equal(amountOf(r, 'AL_LOCAL'), dollars(10.0));
    });
  });

  // 5% flat supplemental election — "Employers may withhold state income
  // tax from bonuses and supplemental wage payments at the rate of 5%."
  describe('5% flat supplemental election', () => {
    test('a standalone bonus, employer elected, is taxed flat at 5% instead of through the formula', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(5000) }],
          workState: { code: 'AL', certificate: { alabamaExemptionCode: 'S' } },
          employer: { supplementalFlatRateElection: { AL: true } },
        }),
      );
      assert.equal(amountOf(r, 'AL_SIT_SUPP'), dollars(250.0)); // 5000 * 5%
      // Nothing runs through the ordinary AL_SIT formula for this bonus.
      assert.equal(amountOf(r, 'AL_SIT'), 0);
    });

    test('without the election, the same bonus runs through the ordinary annualizing formula instead', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(5000) }],
          workState: { code: 'AL', certificate: { alabamaExemptionCode: 'S' } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'AL_SIT_SUPP'), false);
      assert.ok(amountOf(r, 'AL_SIT') > 0);
    });

    test('a bonus paid alongside regular wages is not carved out even when the employer elected 5% ("always", not "paid_separately")', () => {
      const withBonus = calculatePaycheck(
        input({
          payFrequency: 'biweekly',
          earnings: [
            { code: 'REG', category: 'regular', amount: dollars(2000) },
            { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
          ],
          workState: { code: 'AL', certificate: { alabamaExemptionCode: 'S' } },
          employer: { supplementalFlatRateElection: { AL: true } },
        }),
      );
      // appliesWhen: 'always' means the 5% flat line fires whether or not
      // the bonus is paid on its own cheque -- unlike Ohio's paid_separately shape.
      assert.equal(amountOf(withBonus, 'AL_SIT_SUPP'), dollars(50.0));
    });
  });

  // Exempt classes of employment -- Alabama's own booklet: "the chief
  // classes of exempt employment are domestic services in private homes...
  // duly ordained ministers... and agricultural employees," and explicitly
  // does NOT follow the federal rule that would otherwise tax agricultural
  // cash wages once the federal thresholds are met.
  describe('exempt employment categories', () => {
    test('a household (domestic) worker owes $0 AL_SIT regardless of the A-4 on file', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
          workState: { code: 'AL', certificate: { alabamaExemptionCode: '0' } },
          employmentCategory: 'household',
        }),
      );
      assert.equal(amountOf(r, 'AL_SIT'), 0);
    });

    test('an agricultural worker owes $0 AL_SIT even though the same wages could be federally taxable', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(400) }],
          workState: { code: 'AL', certificate: { alabamaExemptionCode: '0' } },
          employmentCategory: 'agricultural',
        }),
      );
      assert.equal(amountOf(r, 'AL_SIT'), 0);
    });

    test('clergy owes $0 AL_SIT', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'monthly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(2800) }],
          workState: { code: 'AL', certificate: { alabamaExemptionCode: '0' } },
          employmentCategory: 'clergy',
        }),
      );
      assert.equal(amountOf(r, 'AL_SIT'), 0);
    });

    test('the exemption is state-income-tax-only: a household worker in a taxing city still owes AL_LOCAL', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
          workState: { code: 'AL', certificate: { workCity: 'Birmingham' } },
          employmentCategory: 'household',
        }),
      );
      assert.equal(amountOf(r, 'AL_SIT'), 0);
      assert.equal(amountOf(r, 'AL_LOCAL'), dollars(5.0)); // 1% of $500
    });

    test('a standard employee is unaffected by this mechanism', () => {
      const r = calculatePaycheck(
        input({
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
          workState: { code: 'AL', certificate: { alabamaExemptionCode: '0' } },
        }),
      );
      assert.ok(amountOf(r, 'AL_SIT') > 0);
    });
  });

  // The $50,000 severance/termination-pay exemption -- conditional on
  // Department of Revenue approval this engine cannot see, so nothing is
  // exempt until the caller asserts certificate.severanceApprovalOnFile.
  describe('severance pay exemption', () => {
    test('approved severance is excluded from the AL taxable base before annualizing', () => {
      const approved = calculatePaycheck(
        input({
          payFrequency: 'monthly',
          earnings: [
            { code: 'REG', category: 'regular', amount: dollars(6000) },
            { code: 'SEVERANCE', category: 'regular', amount: dollars(18000) },
          ],
          workState: {
            code: 'AL',
            certificate: {
              alabamaExemptionCode: '0',
              severanceExemptWages: dollars(18000),
              severanceApprovalOnFile: true,
            },
          },
          federalW4: {
            filingStatus: 'single',
            multipleJobs: false,
            dependentCredit: 0,
            otherIncome: 0,
            deductions: 0,
            extraWithholding: 0,
            exempt: true,
          },
        }),
      );
      const notPaid = calculatePaycheck(
        input({
          payFrequency: 'monthly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(6000) }],
          workState: { code: 'AL', certificate: { alabamaExemptionCode: '0' } },
          federalW4: {
            filingStatus: 'single',
            multipleJobs: false,
            dependentCredit: 0,
            otherIncome: 0,
            deductions: 0,
            extraWithholding: 0,
            exempt: true,
          },
        }),
      );
      // Fully exempt severance should leave the AL tax identical to a
      // cheque that never had the severance dollars at all.
      assert.equal(amountOf(approved, 'AL_SIT'), amountOf(notPaid, 'AL_SIT'));
    });

    test('without approval on file, severance is ordinary taxable wages', () => {
      const noApproval = calculatePaycheck(
        input({
          payFrequency: 'monthly',
          earnings: [
            { code: 'REG', category: 'regular', amount: dollars(6000) },
            { code: 'SEVERANCE', category: 'regular', amount: dollars(18000) },
          ],
          workState: {
            code: 'AL',
            certificate: { alabamaExemptionCode: '0', severanceExemptWages: dollars(18000) },
          },
        }),
      );
      const withApproval = calculatePaycheck(
        input({
          payFrequency: 'monthly',
          earnings: [
            { code: 'REG', category: 'regular', amount: dollars(6000) },
            { code: 'SEVERANCE', category: 'regular', amount: dollars(18000) },
          ],
          workState: {
            code: 'AL',
            certificate: {
              alabamaExemptionCode: '0',
              severanceExemptWages: dollars(18000),
              severanceApprovalOnFile: true,
            },
          },
        }),
      );
      assert.ok(amountOf(noApproval, 'AL_SIT') > amountOf(withApproval, 'AL_SIT'));
    });

    test('the $50,000 cap is per employee per year: YTD usage reduces the room left on this cheque', () => {
      // $15,000 already used this year leaves $35,000 of room. $42,000
      // requested this period should exempt only $35,000, leaving $7,000
      // taxable on top of the $5,000 regular wages = $12,000 taxable base.
      const r = calculatePaycheck(
        input({
          payFrequency: 'monthly',
          earnings: [
            { code: 'REG', category: 'regular', amount: dollars(5000) },
            { code: 'SEVERANCE', category: 'regular', amount: dollars(42000) },
          ],
          workState: {
            code: 'AL',
            certificate: {
              alabamaExemptionCode: 'M',
              dependents: 1,
              severanceExemptWages: dollars(42000),
              severanceApprovalOnFile: true,
              severanceExemptYtd: dollars(15000),
            },
          },
        }),
      );
      assert.equal(
        r.taxes.find((t) => t.id === 'AL_SIT')?.taxableWages,
        dollars(12000), // 5000 regular + (42000 - 35000 remaining) taxable severance
      );
    });
  });

  // certificate.exemptReason -- Alabama recognises several distinct
  // exemptions (four federal statutes plus merchant seamen) that all
  // arrive as the same certificate.exempt boolean; exemptReason lets the
  // caller say which one, and it should show up in the line's own detail.
  test('certificate.exemptReason is carried into the AL_SIT line detail', () => {
    const r = calculatePaycheck(
      input({
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2400) }],
        workState: {
          code: 'AL',
          certificate: {
            exempt: true,
            exemptReason: 'Military Spouses Residency Relief Act (P.L. 111-97)',
          },
        },
      }),
    );
    assert.equal(amountOf(r, 'AL_SIT'), 0);
    const line = r.taxes.find((t) => t.id === 'AL_SIT');
    assert.ok(line?.detail?.includes('Military Spouses Residency Relief Act'));
  });
});

describe('Georgia', () => {
  const gaState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'GA', certificate },
  });

  test("reproduces the guide's own POST-2026-05-11 Table E example exactly: semimonthly $2,000, MFJ, 1 dependent -> $27.03", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...gaState({ georgiaMaritalStatus: 'C', dependents: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'GA_SIT'), dollars(27.03));
  });

  test("reproduces the guide's own POST-2026-05-11 Table F example exactly: biweekly $935, Head of Household, 2 dependents -> $0.00", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(935) }],
        ...gaState({ dependents: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'GA_SIT'), 0);
  });

  test("reproduces the guide's own PRE-2026-05-11 Table E example exactly: semimonthly $1,470.83, MFJ, 1 dependent -> $15.79 (5.19% rate, old deduction)", () => {
    // Confirms the mid-year HB463 transition actually dispatches on
    // checkDate: a payroll BEFORE 2026-05-11 must still use the old
    // 5.19%/$24,000/$4,000 table, not the new one.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-03-15',
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1470.83) }],
        ...gaState({ georgiaMaritalStatus: 'C', dependents: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'GA_SIT'), dollars(15.79));
  });

  test("reproduces the guide's own PRE-2026-05-11 Table F example exactly: biweekly $730.77, Head of Household, 2 dependents -> $0.00", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-03-15',
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(730.77) }],
        ...gaState({ dependents: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'GA_SIT'), 0);
  });

  test('no reciprocity with any state', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        residenceState: { code: 'AL' },
        ...gaState({ georgiaMaritalStatus: 'C', dependents: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'GA_SIT'), dollars(27.03));
  });

  test('MFJ with BOTH spouses working (Status B) gets the LOWER standard deduction, not the MFJ figure — confirmed independently via USDA NFC', () => {
    // Same $2,000 semimonthly, same 1 dependent as the Status C test above,
    // but Status B (MFJ, both spouses working) is NOT the same as Status C
    // (MFJ, one spouse working) despite both being "married filing
    // jointly" on the actual tax return — G-4's own form and NFC's own
    // bulletin (using different letters, S/M/N/H, but the same substance)
    // both single this out as a real, easy-to-miss distinction. Standard
    // deduction stays at $15,000 (the Single/HoH/MFS figure), not $30,000:
    // 48,000 - 15,000 - 5,000 = 28,000 taxable x 4.99% = $1,397.20/yr /
    // 24 = $58.22 — nearly DOUBLE the $27.03 a Status-C employee owes on
    // identical wages, entirely from the standard deduction difference.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...gaState({ georgiaMaritalStatus: 'B', dependents: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'GA_SIT'), dollars(58.22));
  });
});

describe('Louisiana', () => {
  const laState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'LA', certificate },
  });

  test("reproduces R-1306's own Example 1 exactly: weekly $700, Block A claim 1 -> $13.98", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(700) }],
        ...laState({ louisianaBlockA: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'LA_SIT'), dollars(13.98));
  });

  test("reproduces R-1306's own Example 2 exactly: bi-weekly $4,600, Block A claim 2 -> $111.54", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(4600) }],
        ...laState({ louisianaBlockA: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'LA_SIT'), dollars(111.54));
  });

  test('Block A claim 0 (or no certificate at all) gets NO standard deduction — flat 3.09% on the full wage', () => {
    // Form L-4's own text: an employee who never files a certificate is
    // withheld "without any standard deduction" — the same outcome as
    // affirmatively claiming 0. $700/wk x 3.09% = $21.63 exactly.
    const withNoCertificate = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(700) }],
        workState: { code: 'LA', certificate: {} },
      }),
    );
    assert.equal(amountOf(withNoCertificate, 'LA_SIT'), dollars(21.63));

    const withClaimZero = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(700) }],
        ...laState({ louisianaBlockA: 0 }),
      }),
    );
    assert.equal(amountOf(withClaimZero, 'LA_SIT'), dollars(21.63));
  });

  test('a 401(k) deferral reduces the Louisiana taxable base', () => {
    // Same $700/wk, claim 1, but $200/wk goes to a 401(k) first: taxable
    // wages become $500/wk. Annual $26,000 less $12,875 standard deduction
    // = $13,125 taxable x 3.09% = $405.5625/yr -> rounds to $405.56 -> /52
    // = $7.7992... -> $7.80/wk, well below the no-401(k) $13.98 baseline.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(700) }],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(200) }],
        ...laState({ louisianaBlockA: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'LA_SIT'), dollars(7.8));
  });

  test('no reciprocity with any state — a nonresident still owes full Louisiana tax', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(700) }],
        residenceState: { code: 'MS' },
        ...laState({ louisianaBlockA: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'LA_SIT'), dollars(13.98));
  });

  test("daily payroll annualizes on R-1306's own 365 divisor, NOT this engine's generic 260-workday convention", () => {
    // A real bug caught during a 'verify' pass: R-1306's own "Number of Pay
    // Periods in a year" table states Daily = 365, not the 260 this engine
    // uses for every other state's daily frequency (the same mismatch New
    // Jersey's and Delaware's daily tables required their own override
    // for). $100/day, claim 1: annual $36,500 - $12,875 = $23,625 taxable
    // x 3.09% = $729.9825 -> rounds to $730.00... precisely: 23,625 x
    // .0309 = 730.0125 -> $730.01/yr / 365 = $2.0000... -> $2.00/day.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'daily',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(100) }],
        ...laState({ louisianaBlockA: 1 }),
      }),
    );
    assert.equal(amountOf(r, 'LA_SIT'), dollars(2.0));
  });

  test('a frequency R-1306 does not publish (quarterly) throws rather than guessing a divisor', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            checkDate: '2026-06-15',
            payFrequency: 'quarterly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(9000) }],
            ...laState({ louisianaBlockA: 1 }),
          }),
        ),
      /doesn't publish an annualizing multiplier for "quarterly"/,
    );
  });
});

describe('Mississippi', () => {
  const msState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'MS', certificate },
  });

  test("reproduces Pub 89-700's own Table A (Single) cell exactly: weekly $505, $0 exemption -> $11", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(505) }],
        ...msState({ filingStatus: 'single', totalExemptionClaimed: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MS_SIT'), dollars(11));
  });

  test("reproduces Pub 89-700's own Table A (Single) cell exactly: weekly $605, $0 exemption -> $15", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(605) }],
        ...msState({ filingStatus: 'single', totalExemptionClaimed: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MS_SIT'), dollars(15));
  });

  test("reproduces Pub 89-700's own Table A (Single) cell exactly: weekly $495, $6,000 exemption -> $6", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(495) }],
        ...msState({ filingStatus: 'single', totalExemptionClaimed: 6000 }),
      }),
    );
    assert.equal(amountOf(r, 'MS_SIT'), dollars(6));
  });

  test('no certificate on file defaults to Single status and zero exemption — Pub 89-700 Section 12', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(505) }],
        workState: { code: 'MS', certificate: {} },
      }),
    );
    assert.equal(amountOf(r, 'MS_SIT'), dollars(11));
  });

  test('married with spouse NOT employed gets the full $4,600 standard deduction', () => {
    // Monthly $3,000: $36,000 annual - $4,600 = $31,400 - $10,000 = $21,400
    // taxable x 4.0% = $856.00/yr / 12 = $71.33 -> rounds to $71.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
        ...msState({ filingStatus: 'married_spouse_not_employed', totalExemptionClaimed: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MS_SIT'), dollars(71));
  });

  test("married with BOTH spouses employed gets only HALF the deduction — Section 13(d)'s own 'divided equally' rule", () => {
    // Same $3,000 monthly: $36,000 - $2,300 (half of $4,600) = $33,700 -
    // $10,000 = $23,700 taxable x 4.0% = $948.00/yr / 12 = $79.00 exactly —
    // a genuinely higher tax than the spouse-not-employed case above on
    // identical wages, entirely from the halved standard deduction.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
        ...msState({ filingStatus: 'married_both_employed', totalExemptionClaimed: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MS_SIT'), dollars(79));
  });

  test('Head of Family standard deduction plus a Form 89-350 exemption total', () => {
    // Monthly $3,000, Head of Family ($3,400 SD) with the $9,500 base
    // exemption claimed: $36,000 - $3,400 - $9,500 = $23,100 - $10,000 =
    // $13,100 taxable x 4.0% = $524.00/yr / 12 = $43.67 -> rounds to $44.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(3000) }],
        ...msState({ filingStatus: 'head_of_family', totalExemptionClaimed: 9500 }),
      }),
    );
    assert.equal(amountOf(r, 'MS_SIT'), dollars(44));
  });

  test('a 401(k) deferral reduces the Mississippi taxable base', () => {
    // Same $505/wk Single/$0-exemption baseline as the first test above,
    // but $50/wk goes to a 401(k) first: taxable wages become $455/wk,
    // well below the $11/wk no-401(k) baseline.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(505) }],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(50) }],
        ...msState({ filingStatus: 'single', totalExemptionClaimed: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MS_SIT'), dollars(9));
  });

  test('no reciprocity with any state — a nonresident still owes full Mississippi tax', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(505) }],
        residenceState: { code: 'LA' },
        ...msState({ filingStatus: 'single', totalExemptionClaimed: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MS_SIT'), dollars(11));
  });

  test("daily payroll correctly uses this engine's standard 260-day annualization — reproduces Table A's own Daily cell exactly", () => {
    // Checked specifically because Louisiana's own Daily table needed a
    // 365-day override instead of the engine default — verified Mississippi
    // does NOT have the same landmine before assuming either way. Daily
    // $167, Single, $0 exemption: $167 x 260 = $43,420 annual - $2,300 =
    // $41,120 - $10,000 = $31,120 taxable x 4.0% = $1,244.80/yr / 260 =
    // $4.7877 -> rounds to $5/day. Matches Pub 89-700's own Table A
    // (Single, Daily), 166-168 row, $0-exemption column exactly.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'daily',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(167) }],
        ...msState({ filingStatus: 'single', totalExemptionClaimed: 0 }),
      }),
    );
    assert.equal(amountOf(r, 'MS_SIT'), dollars(5));
  });

  // Pub 89-700 Section 9's own supplemental-wages rule: aggregate with the
  // current or last-preceding payroll period, no separate flat rate.
  test('a standalone bonus aggregated with the prior regular payment equals tax-on-combined minus tax-already-withheld', () => {
    const regularOnly = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...msState({ filingStatus: 'single', totalExemptionClaimed: 0 }),
      }),
    );
    const regularTax = amountOf(regularOnly, 'MS_SIT');

    const withAggregation = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'biweekly',
        earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(3000) }],
        ...msState({ filingStatus: 'single', totalExemptionClaimed: 0 }),
        priorRegularPayment: { taxableWages: dollars(2000), stateIncomeTaxWithheld: regularTax },
      }),
    );

    const combinedAsOneCheque = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...msState({ filingStatus: 'single', totalExemptionClaimed: 0 }),
      }),
    );
    const expectedMarginal = amountOf(combinedAsOneCheque, 'MS_SIT') - regularTax;

    assert.equal(amountOf(withAggregation, 'MS_SIT'), expectedMarginal);
  });
});

describe('Texas', () => {
  test('no state wage income tax — TX_SIT is not produced', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(700) }],
        workState: { code: 'TX', certificate: {} },
      }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'TX_SIT'), false);
  });
});

describe('New Mexico', () => {
  describe("workers' compensation fee ($2.25 employee / $2.55 employer per quarter)", () => {
    const nm = (overrides: Partial<PaycheckInput> = {}) =>
      calculatePaycheck(input({ workState: { code: 'NM', certificate: {} }, ...overrides }));

    test('prorated by default: semimonthly $2.25 x 4 / 24 = $0.375 -> $0.38, monthly $0.75 (matches PaycheckCity)', () => {
      assert.equal(amountOf(nm({ payFrequency: 'semimonthly' }), 'NM_WC_FEE_EE'), dollars(0.38));
      const monthly = nm({ payFrequency: 'monthly' });
      assert.equal(amountOf(monthly, 'NM_WC_FEE_EE'), dollars(0.75));
      assert.equal(amountOf(monthly, 'NM_WC_FEE_ER'), dollars(0.85));
    });

    test("'full' takes the whole quarterly share on this cheque; 'skip' takes nothing", () => {
      const full = nm({ employer: { quarterlyHeadFeeCollection: { NM: 'full' } } });
      assert.equal(amountOf(full, 'NM_WC_FEE_EE'), dollars(2.25));
      assert.equal(amountOf(full, 'NM_WC_FEE_ER'), dollars(2.55));
      const skip = nm({ employer: { quarterlyHeadFeeCollection: { NM: 'skip' } } });
      assert.equal(skip.taxes.some((t) => t.id.startsWith('NM_WC_FEE')), false);
    });

    test('domestic and farm workers are exempt', () => {
      assert.equal(nm({ employmentCategory: 'household' }).taxes.some((t) => t.id.startsWith('NM_WC_FEE')), false);
      assert.equal(nm({ employmentCategory: 'agricultural' }).taxes.some((t) => t.id.startsWith('NM_WC_FEE')), false);
    });
  });

  const nmState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'NM', certificate },
  });

  test("reproduces FYI-104's own worked example exactly: weekly $1,000, married -> $21.80", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...nmState({ filingStatus: 'married_joint' }),
      }),
    );
    assert.equal(amountOf(r, 'NM_SIT'), dollars(21.8));
  });

  test("reproduces FYI-104's own worked example WITH the additional withholding it adds on top: $21.80 + $20.00 = $41.80", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...nmState({ filingStatus: 'married_joint', additionalWithholding: dollars(20) }),
      }),
    );
    assert.equal(amountOf(r, 'NM_SIT'), dollars(41.8));
  });

  test('no certificate on file defaults to the Single table, not Married — same wage taxed differently', () => {
    // Weekly $200: Single's own bracket (155-261, 1.5%) taxes $0.68;
    // Married's own bracket (0-310, 0%) taxes $0.00 on the identical wage.
    const noCert = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
        workState: { code: 'NM', certificate: {} },
      }),
    );
    assert.equal(amountOf(noCert, 'NM_SIT'), dollars(0.68));

    const married = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
        ...nmState({ filingStatus: 'married_joint' }),
      }),
    );
    assert.equal(amountOf(married, 'NM_SIT'), 0);
  });

  test("'married filing separately' resolves to the SAME Single table the federal W-4 checkbox bundles it with", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
        ...nmState({ filingStatus: 'married_separate' }),
      }),
    );
    assert.equal(amountOf(r, 'NM_SIT'), dollars(0.68));
  });

  test('Head of Household uses its own table, distinct from both Single and Married', () => {
    // Weekly $300: Single's own bracket (261-395, 3.2%, base $1.59) taxes
    // $2.84; HoH's own bracket (232-386, 1.5%, base $0) taxes $1.02 on the
    // identical wage — genuinely different, not just a relabeled Single.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(300) }],
        ...nmState({ filingStatus: 'head_of_household' }),
      }),
    );
    assert.equal(amountOf(r, 'NM_SIT'), dollars(1.02));
  });

  test("Semi-Monthly table uses the CORRECT $335 zero-bracket threshold, not FYI-104's own erroneous $304 summary line", () => {
    // A real, disclosed error in New Mexico's own published PDF: the
    // Semi-Monthly table's "Not Over" summary line prints $304, but that
    // table's own first bracket row (and algebraic scaling from the
    // Annual table) both independently confirm $335 is correct. $330/pay
    // period sits between the two figures — taxed $0.00 under the correct
    // $335 threshold, which is what this test locks in.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(330) }],
        ...nmState({ filingStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'NM_SIT'), 0);
  });

  test('Daily payroll period looks up its own published table directly — no annualize/divide step', () => {
    // $200/day, Single: bracket 159.80-225.20, 4.7%, base $4.48.
    // (200.00 - 159.80) x 4.7% = 1.8894 -> $1.89 + $4.48 = $6.37.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'daily',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(200) }],
        ...nmState({ filingStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'NM_SIT'), dollars(6.37));
  });

  test('Quarterly payroll period looks up its own published table directly', () => {
    // $5,000/quarter, Single: bracket 3,388-5,138, 3.2%, base $20.63.
    // (5,000-3,388) x 3.2% = 51.584 -> $51.58 + $20.63 = $72.21.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'quarterly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...nmState({ filingStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'NM_SIT'), dollars(72.21));
  });

  test('supplemental wages withhold a flat 5.9%, independent of the regular-wage bracket, WITHOUT being taxed twice', () => {
    // A real double-taxation bug lived here until a later "go to every
    // state" pass: NM_SIT used to compute its bracket over periodWages
    // that still INCLUDED the bonus, so the $1,000 supplemental payment
    // was taxed once via NM_SIT's bracket AND again via NM_SIT_SUPP's flat
    // 5.9% — this test now asserts BOTH lines, not just the supplemental
    // one, so that regression can't go silent again. NM_SIT must see only
    // the $700 regular wage (bracket [645,799): 15.80 + 4.3% × 55 =
    // $18.16), not $1,700.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(700) },
          { code: 'BONUS', category: 'supplemental', amount: dollars(1000) },
        ],
        ...nmState({ filingStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'NM_SIT'), dollars(18.16));
    assert.equal(amountOf(r, 'NM_SIT_SUPP'), dollars(59.0));
  });

  test('a claimed exemption zeroes withholding entirely (certificate.exempt)', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...nmState({ filingStatus: 'married_joint', exempt: true }),
      }),
    );
    assert.equal(amountOf(r, 'NM_SIT'), 0);
  });

  test('no bilateral reciprocity with any state — a nonresident still owes full New Mexico tax on NM-source wages', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        residenceState: { code: 'TX' },
        ...nmState({ filingStatus: 'married_joint' }),
      }),
    );
    assert.equal(amountOf(r, 'NM_SIT'), dollars(21.8));
  });

  test('a 401(k) deferral reduces the New Mexico taxable base', () => {
    // Same $1,000/wk married baseline ($21.80), but $210/wk to a 401(k)
    // drops taxable wages to $790/wk — exactly the bracket floor, so the
    // full 4.3% bracket is skipped entirely and tax falls to the $12.77
    // base of the bracket below it, not just a proportional reduction.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(210) }],
        ...nmState({ filingStatus: 'married_joint' }),
      }),
    );
    assert.equal(amountOf(r, 'NM_SIT'), dollars(12.77));
  });

  test('an unrecognized filingStatus throws rather than silently falling through to single', () => {
    assert.throws(
      () => calculatePaycheck(input(nmState({ filingStatus: 'divorced' }))),
      /Unrecognized NM certificate\.filingStatus/,
    );
  });
});

describe('Hawaii', () => {
  const hiState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'HI', certificate },
  });

  test("reproduces Booklet A's own worked example exactly: single, weekly $500, 3 allowances -> $9.58", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        ...hiState({ hawaiiMaritalStatus: 'single', allowances: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'HI_SIT'), dollars(9.58));
  });

  test('married status uses the wider Married bracket table, not Single', () => {
    // Same $500/wk, 3 allowances, but married: 26,000 - 3,432 - 4,350 =
    // 18,218 taxable falls in Married's FIRST bracket (0-19,200, 1.40%)
    // instead of Single's third bracket — 18,218 x 1.40% = $255.05/yr / 52
    // = $4.90/wk, a much smaller number than the $9.58 Single produces on
    // identical wages, proving the two tables are genuinely different, not
    // aliased.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        ...hiState({ hawaiiMaritalStatus: 'married', allowances: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'HI_SIT'), dollars(4.9));
  });

  test('absent certificate defaults to single with zero allowances, per HW-4\'s own instruction', () => {
    // 26,000 annual - 0 allowances - 4,350 lump sum = 21,650 taxable,
    // Single bracket 4 (19,200-24,000): 552.00 + 6.4% x 2,450 = $708.80/yr
    // / 52 = $13.6308 -> $13.63/wk.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        workState: { code: 'HI' },
      }),
    );
    assert.equal(amountOf(r, 'HI_SIT'), dollars(13.63));
  });

  test('a certified disabled person owes $0, not the generic certificate.exempt flag', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...hiState({ hawaiiMaritalStatus: 'certified_disabled' }),
      }),
    );
    assert.equal(amountOf(r, 'HI_SIT'), 0);
  });

  test('a nonresident military spouse owes $0', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...hiState({ hawaiiMaritalStatus: 'nonresident_military_spouse' }),
      }),
    );
    assert.equal(amountOf(r, 'HI_SIT'), 0);
  });

  test('no reciprocity with any state', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        residenceState: { code: 'CA' },
        ...hiState({ hawaiiMaritalStatus: 'single', allowances: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'HI_SIT'), dollars(9.58));
  });

  test('a 401(k) deferral reduces the Hawaii taxable base', () => {
    // Same $500/wk single/3-allowances baseline ($9.58 taxable at 18,218),
    // but $300/wk to a 401(k) drops taxable annual wages to (200x52) -
    // 3,432 - 4,350 = 2,618 — out of the 5.5% bracket entirely and down
    // into bracket 1 (0-9,600, 1.40%): 2,618 x 1.40% = $36.65/yr / 52 =
    // $0.7048 -> $0.70/wk.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(300) }],
        ...hiState({ hawaiiMaritalStatus: 'single', allowances: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'HI_SIT'), dollars(0.7));
  });

  test('TDI: 0.5% of wages, capped at $7.50/week', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
        ...hiState({ hawaiiMaritalStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'HI_DBL_EE'), dollars(5.0)); // 1,000 × 0.5%
  });

  test('TDI caps at $7.50/week even on high wages', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...hiState({ hawaiiMaritalStatus: 'single' }),
      }),
    );
    assert.equal(amountOf(r, 'HI_DBL_EE'), dollars(7.5)); // would be $25 uncapped
  });

  // Booklet A Section 14(e)'s own supplemental-wages rule: aggregate with
  // the current or last-preceding payroll period, no separate flat rate.
  test('a standalone bonus aggregated with the prior regular payment equals tax-on-combined minus tax-already-withheld', () => {
    const regularOnly = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...hiState({ hawaiiMaritalStatus: 'single', allowances: 1 }),
      }),
    );
    const regularTax = amountOf(regularOnly, 'HI_SIT');

    const withAggregation = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'biweekly',
        earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(3000) }],
        ...hiState({ hawaiiMaritalStatus: 'single', allowances: 1 }),
        priorRegularPayment: { taxableWages: dollars(2000), stateIncomeTaxWithheld: regularTax },
      }),
    );

    const combinedAsOneCheque = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'biweekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(5000) }],
        ...hiState({ hawaiiMaritalStatus: 'single', allowances: 1 }),
      }),
    );
    const expectedMarginal = amountOf(combinedAsOneCheque, 'HI_SIT') - regularTax;

    assert.equal(amountOf(withAggregation, 'HI_SIT'), expectedMarginal);
  });
});

describe('Alaska', () => {
  const ak = { workState: { code: 'AK' } };

  test('no state income tax', () => {
    const r = calculatePaycheck(input(ak));
    const line = r.taxes.find((t) => t.id === 'AK_SIT');
    assert.equal(line, undefined);
  });

  // Alaska is one of only three states in this project (with PA and NJ)
  // that taxes the EMPLOYEE for unemployment insurance, not just the
  // employer — confirmed directly from labor.alaska.gov's own 2026 rate
  // table: flat 0.50% for every employer regardless of experience class.
  test('employee UI withholding: 0.50% of gross wages', () => {
    const r = calculatePaycheck(input(ak));
    assert.equal(amountOf(r, 'AK_UC_EE'), dollars(15)); // 3,000 × 0.50%
  });

  test('employee UI stops once the $54,200 annual wage base is reached', () => {
    const r = calculatePaycheck(
      input({
        ...ak,
        ytd: {
          socialSecurity: 0,
          medicare: 0,
          futa: 0,
          stateUnemployment: { AK: dollars(53_000) },
        },
      }),
    );
    // Only $1,200 of room left under the $54,200 cap before this $3,000
    // cheque: 1,200 × 0.50% = $6.00, not 3,000 × 0.50% = $15.00.
    assert.equal(amountOf(r, 'AK_UC_EE'), dollars(6));
  });

  test('a 401(k) deferral does NOT reduce the AK UI base — same taxable-wages rule as every other state UC', () => {
    const r = calculatePaycheck(
      input({
        ...ak,
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(500) }],
      }),
    );
    assert.equal(amountOf(r, 'AK_UC_EE'), dollars(15)); // still 3,000 × 0.50%
  });
});

describe('Oklahoma', () => {
  const okState = (certificate: Record<string, unknown> = {}) => ({
    workState: { code: 'OK', certificate },
  });

  test("reproduces OW-2's own Sample Computation exactly: semi-monthly $1,825, married, 2 allowances -> $37.00", () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1825) }],
        ...okState({ filingStatus: 'married', allowances: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'OK_SIT'), dollars(37));
  });

  test("'Married, but withhold at higher Single rate' resolves to the SINGLE table, not Married", () => {
    // Same $1,825 semimonthly, 2 allowances as the worked example above, but
    // this election uses the narrower Single brackets instead — net $1,741.66
    // now lands in Single's top bracket (565+, 4.5%): 4.55 + 4.5% x 1,176.66
    // = $57.50 -> rounds to $58.00, well above the Married table's $37.00 on
    // identical wages.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'semimonthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1825) }],
        ...okState({ filingStatus: 'married_withhold_as_single', allowances: 2 }),
      }),
    );
    assert.equal(amountOf(r, 'OK_SIT'), dollars(58));
  });

  test('absent certificate defaults to Single with zero allowances', () => {
    // Weekly $500, no certificate: net $500 (no allowance deduction) lands
    // in Single's top bracket (261+, 4.5%): 2.10 + 4.5% x 239 = $12.86 ->
    // rounds to $13.00.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        workState: { code: 'OK' },
      }),
    );
    assert.equal(amountOf(r, 'OK_SIT'), dollars(13));
  });

  test('a claimed exemption (OK-W-4 Line 7/8/9) zeroes withholding entirely (certificate.exempt)', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(2000) }],
        ...okState({ filingStatus: 'single', exempt: true }),
      }),
    );
    assert.equal(amountOf(r, 'OK_SIT'), 0);
  });

  test('no reciprocity with any state', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        residenceState: { code: 'TX' },
        workState: { code: 'OK' },
      }),
    );
    assert.equal(amountOf(r, 'OK_SIT'), dollars(13));
  });

  test('a 401(k) deferral reduces the Oklahoma taxable base', () => {
    // Same weekly $500/single/3-allowances baseline ($10.00), but $100/wk
    // to a 401(k) drops net wages from $442.31 to $342.31, still in the
    // 4.5% bracket but on a smaller excess: 2.10 + 4.5% x 81.31 = $5.76 ->
    // rounds to $6.00.
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        deductions: [{ code: '401K', category: 'deferral_401k', amount: dollars(100) }],
        ...okState({ filingStatus: 'single', allowances: 3 }),
      }),
    );
    assert.equal(amountOf(r, 'OK_SIT'), dollars(6));
  });

  test('additional withholding (OK-W-4 Line 6) adds on top of the computed amount', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(500) }],
        ...okState({ filingStatus: 'single', additionalWithholding: dollars(25) }),
      }),
    );
    // $13.00 base (same as the absent-certificate case above) + $25.00 = $38.00.
    assert.equal(amountOf(r, 'OK_SIT'), dollars(38));
  });

  test('an unrecognized filingStatus throws rather than silently falling through to single', () => {
    assert.throws(
      () => calculatePaycheck(input(okState({ filingStatus: 'divorced' }))),
      /Unrecognized OK certificate\.filingStatus/,
    );
  });
});

describe('Wyoming', () => {
  test('no state wage income tax — WY_SIT is not produced', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(700) }],
        workState: { code: 'WY' },
      }),
    );
    const line = r.taxes.find((t) => t.id === 'WY_SIT');
    assert.equal(line, undefined);
  });
});

// FL/NV/SD/TN data files (method: 'no_income_tax') existed with no
// confirming test, unlike AK/TX/WY — a real coverage gap closed in the
// comprehensive-audit pass: nothing previously proved the dispatch case
// actually fires for these 4 states specifically rather than falling
// through to the "NOT MODELLED" placeholder line stateIncomeTax() emits
// for a genuinely missing ruleset.
describe('no-income-tax states without a prior confirming test', () => {
  for (const code of ['FL', 'NV', 'SD', 'TN']) {
    test(`${code}: no state wage income tax — ${code}_SIT is not produced`, () => {
      const r = calculatePaycheck(
        input({
          checkDate: '2026-06-15',
          payFrequency: 'weekly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(700) }],
          workState: { code },
        }),
      );
      const line = r.taxes.find((t) => t.id === `${code}_SIT`);
      assert.equal(line, undefined);
    });
  }
});

describe('North Dakota', () => {
  test('Section 1 (pre-2020 W-4): weekly $1,500, single, 2 allowances -> $4.00', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'weekly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(1500) }],
        workState: {
          code: 'ND',
          certificate: { formVintage: 'pre_2020', maritalStatus: 'single', allowances: 2 },
        },
      }),
    );
    assert.equal(amountOf(r, 'ND_SIT'), dollars(4));
  });

  test('Section 2 (2020+ W-4): reads status from federalW4.filingStatus, not a separate ND certificate — Single', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(8000) }],
        federalW4: {
          filingStatus: 'single',
          multipleJobs: false,
          dependentCredit: 0,
          otherIncome: 0,
          deductions: 0,
          extraWithholding: 0,
        },
        workState: { code: 'ND' },
      }),
    );
    assert.equal(amountOf(r, 'ND_SIT'), dollars(62));
  });

  test('Section 2: Married Filing Jointly uses its own wider table, not Single', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(8000) }],
        federalW4: {
          filingStatus: 'married_joint',
          multipleJobs: false,
          dependentCredit: 0,
          otherIncome: 0,
          deductions: 0,
          extraWithholding: 0,
        },
        workState: { code: 'ND' },
      }),
    );
    assert.equal(amountOf(r, 'ND_SIT'), dollars(63));
  });

  test('Section 2: Head of Household uses the widest table of the three', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(8000) }],
        federalW4: {
          filingStatus: 'head_of_household',
          multipleJobs: false,
          dependentCredit: 0,
          otherIncome: 0,
          deductions: 0,
          extraWithholding: 0,
        },
        workState: { code: 'ND' },
      }),
    );
    assert.equal(amountOf(r, 'ND_SIT'), dollars(28));
  });

  test('no reciprocity zeroing for a non-MN/MT resident', () => {
    const r = calculatePaycheck(
      input({
        checkDate: '2026-06-15',
        payFrequency: 'monthly',
        earnings: [{ code: 'REG', category: 'regular', amount: dollars(8000) }],
        residenceState: { code: 'TX' },
        workState: { code: 'ND' },
      }),
    );
    assert.equal(amountOf(r, 'ND_SIT'), dollars(62));
  });

  // Section 3's own two employer options: flat 1.50%, or aggregate with the
  // most recent regular payroll period.
  describe('Supplemental wages (Section 3)', () => {
    test("Option 1 reproduces the booklet's own worked example exactly: $1,000 bonus x 1.50% = $15.00, when elected", () => {
      const r = calculatePaycheck(
        input({
          checkDate: '2026-06-15',
          payFrequency: 'monthly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(1000) }],
          workState: { code: 'ND', certificate: { formVintage: 'current' } },
          employer: { supplementalFlatRateElection: { ND: true } },
        }),
      );
      assert.equal(amountOf(r, 'ND_SIT_SUPP'), dollars(15.0));
    });

    test('without an election, no flat line fires — falls back to the ordinary formula', () => {
      const r = calculatePaycheck(
        input({
          checkDate: '2026-06-15',
          payFrequency: 'monthly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(1000) }],
          workState: { code: 'ND', certificate: { formVintage: 'current' } },
        }),
      );
      assert.equal(r.taxes.some((t) => t.id === 'ND_SIT_SUPP'), false);
    });

    test('Option 2 (aggregate with the most recent regular payroll period) works via input.priorRegularPayment', () => {
      const regularOnly = calculatePaycheck(
        input({
          checkDate: '2026-06-15',
          payFrequency: 'monthly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(5500) }],
          workState: { code: 'ND', certificate: { formVintage: 'current' } },
        }),
      );
      const regularTax = amountOf(regularOnly, 'ND_SIT');

      const withAggregation = calculatePaycheck(
        input({
          checkDate: '2026-06-15',
          payFrequency: 'monthly',
          earnings: [{ code: 'BONUS', category: 'supplemental', amount: dollars(1000) }],
          workState: { code: 'ND', certificate: { formVintage: 'current' } },
          priorRegularPayment: { taxableWages: dollars(5500), stateIncomeTaxWithheld: regularTax },
        }),
      );
      assert.equal(withAggregation.taxes.some((t) => t.id === 'ND_SIT_SUPP'), false);

      const combinedAsOneCheque = calculatePaycheck(
        input({
          checkDate: '2026-06-15',
          payFrequency: 'monthly',
          earnings: [{ code: 'REG', category: 'regular', amount: dollars(6500) }],
          workState: { code: 'ND', certificate: { formVintage: 'current' } },
        }),
      );
      const expectedMarginal = amountOf(combinedAsOneCheque, 'ND_SIT') - regularTax;
      assert.equal(amountOf(withAggregation, 'ND_SIT'), expectedMarginal);
    });
  });

  test('Section 1: an unrecognized maritalStatus throws rather than silently falling through to single', () => {
    assert.throws(
      () =>
        calculatePaycheck(
          input({
            checkDate: '2026-06-15',
            payFrequency: 'weekly',
            earnings: [{ code: 'REG', category: 'regular', amount: dollars(1500) }],
            workState: {
              code: 'ND',
              certificate: { formVintage: 'pre_2020', maritalStatus: 'divorced', allowances: 2 },
            },
          }),
        ),
      /Unrecognized ND certificate\.maritalStatus/,
    );
  });
});

describe('effective dating', () => {
  test('the ruleset is chosen by check date, not by the clock', () => {
    assert.throws(
      () => calculatePaycheck(input({ checkDate: '2019-06-15' })),
      /no 2019 rules for federal tax/,
    );
  });

  test('a malformed check date is rejected outright', () => {
    assert.throws(
      () => calculatePaycheck(input({ checkDate: '06/15/2026' })),
      /ISO yyyy-mm-dd/,
    );
  });
});

/**
 * State unemployment, EMPLOYER side — the levy every state charges and this
 * engine computed in none of them until now. Figures below are the real
 * published 2026 ones: Ohio's new-employer rate 2.85% on a $9,000 base,
 * California 3.4% on $7,000, Washington's $78,200 base with no single
 * published new-employer rate.
 */
describe('state unemployment insurance, employer side (XX_SUI_ER)', () => {
  const suiInput = (extra: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(3000) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    ...extra,
  });

  test("falls back to the state's published new-employer rate, and says so", () => {
    const r = calculatePaycheck(suiInput({ workState: { code: 'OH', certificate: {} } }));
    assert.equal(amountOf(r, 'OH_SUI_ER'), dollars(85.5));
    const line = r.taxes.find((t) => t.id === 'OH_SUI_ER');
    assert.equal(line?.payer, 'employer');
    assert.match(line?.detail ?? '', /new-employer rate/);
  });

  test("an employer's own assigned rate overrides the default", () => {
    const r = calculatePaycheck(
      suiInput({
        workState: { code: 'OH', certificate: {} },
        employer: { stateUnemploymentRate: { OH: 0.041 } },
      }),
    );
    assert.equal(amountOf(r, 'OH_SUI_ER'), dollars(123.0));
    assert.match(r.taxes.find((t) => t.id === 'OH_SUI_ER')?.detail ?? '', /own assigned rate/);
  });

  test('stops at the wage base, counting YTD wages already reported', () => {
    // Ohio's base is $9,000; $8,500 is already counted, so only $500 of this
    // $3,000 cheque is still taxable.
    const r = calculatePaycheck(
      suiInput({
        workState: { code: 'OH', certificate: {} },
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, stateUnemployment: { OH: dollars(8500) } },
      }),
    );
    assert.equal(amountOf(r, 'OH_SUI_ER'), dollars(14.25));
  });

  test('an employee already over the wage base costs the employer nothing more', () => {
    const r = calculatePaycheck(
      suiInput({
        workState: { code: 'OH', certificate: {} },
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, stateUnemployment: { OH: dollars(9000) } },
      }),
    );
    assert.equal(amountOf(r, 'OH_SUI_ER'), dollars(0));
  });

  test('a state with no single published new-employer rate produces NO line rather than a guess', () => {
    // Washington assigns rates by schedule, not a flat new-employer figure.
    const r = calculatePaycheck(suiInput({ workState: { code: 'WA', certificate: {} } }));
    assert.equal(r.taxes.some((t) => t.id === 'WA_SUI_ER'), false);
  });

  test('...and computes normally once that employer supplies its own rate', () => {
    const r = calculatePaycheck(
      suiInput({
        workState: { code: 'WA', certificate: {} },
        employer: { stateUnemploymentRate: { WA: 0.012 } },
      }),
    );
    assert.equal(amountOf(r, 'WA_SUI_ER'), dollars(36.0));
  });

  test("Kansas: a construction employer gets its own 5.55% rate, not the flat 1.75%", () => {
    // $3,000 biweekly, well under the $15,100 wage base -- fully taxable.
    const general = calculatePaycheck(suiInput({ workState: { code: 'KS', certificate: {} } }));
    assert.equal(amountOf(general, 'KS_SUI_ER'), dollars(52.5)); // 1.75% * $3,000
    assert.match(general.taxes.find((t) => t.id === 'KS_SUI_ER')?.detail ?? '', /new-employer rate \(no employer rate supplied/);

    const construction = calculatePaycheck(
      suiInput({
        workState: { code: 'KS', certificate: {} },
        employer: { suiIndustry: { KS: 'construction' } },
      }),
    );
    assert.equal(amountOf(construction, 'KS_SUI_ER'), dollars(166.5)); // 5.55% * $3,000
    assert.match(
      construction.taxes.find((t) => t.id === 'KS_SUI_ER')?.detail ?? '',
      /"construction" industry classification/,
    );
  });

  test("Kansas: an explicit employer-supplied rate still overrides the industry rate", () => {
    const r = calculatePaycheck(
      suiInput({
        workState: { code: 'KS', certificate: {} },
        employer: { suiIndustry: { KS: 'construction' }, stateUnemploymentRate: { KS: 0.02 } },
      }),
    );
    assert.equal(amountOf(r, 'KS_SUI_ER'), dollars(60.0)); // 2% * $3,000, not 5.55%
    assert.match(r.taxes.find((t) => t.id === 'KS_SUI_ER')?.detail ?? '', /own assigned rate/);
  });

  test('it is an employer cost, not withheld from the employee', () => {
    const withSui = calculatePaycheck(suiInput({ workState: { code: 'CA', certificate: {} } }));
    const line = withSui.taxes.find((t) => t.id === 'CA_SUI_ER');
    assert.equal(line?.amount, dollars(102.0));
    // California's base is $7,000 at a 3.4% new-employer rate.
    assert.ok(withSui.employerTaxTotal >= line!.amount);
    assert.equal(
      withSui.taxes.filter((t) => t.payer === 'employee').some((t) => t.id === 'CA_SUI_ER'),
      false,
    );
  });

  test('every state file carries the block the calculation reads', () => {
    // A missing suiEmployer block would silently drop the tax for that
    // state, which is exactly the failure mode this replaces. wageBase is
    // either a plain number or Michigan's two-tier { default,
    // qualifiedEmployer } shape (see resolveSUIWageBase() in state.ts) —
    // either way it must resolve to real numbers, not silently be missing.
    const states = readdirSync(join(import.meta.dirname, '..', 'data', 'states'));
    // 51 for the current year; earlier years (2025) cover only some states.
    assert.equal(states.filter((f) => f.endsWith('-2026.json')).length, 51);
    for (const file of states) {
      const parsed = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'states', file), 'utf8'));
      assert.ok(parsed.suiEmployer, `${file} has no suiEmployer block`);
      const wageBase = parsed.suiEmployer.wageBase;
      const isValidTwoTier =
        wageBase !== null &&
        typeof wageBase === 'object' &&
        typeof wageBase.default === 'number' &&
        typeof wageBase.qualifiedEmployer === 'number';
      assert.ok(
        typeof wageBase === 'number' || isValidTwoTier,
        `${file} has no numeric (or valid two-tier) wage base`,
      );
    }
  });

  describe('two-tier wage base (Michigan)', () => {
    // YTD is set to $9,200 so the two caps ($9,500 default vs. $9,000
    // qualified) actually diverge within this one $3,000 period — with a
    // clean $0 YTD, both caps sit far above the period wage and the two
    // tiers would produce an identical (and so non-distinguishing) result.
    const nearCapExtra = { ytd: { socialSecurity: 0, medicare: 0, futa: 0, stateUnemployment: { MI: dollars(9200) } } };

    test('no employer qualification supplied: defaults to the higher $9,500 base — $300 of room left, taxed at 2.7%', () => {
      const r = calculatePaycheck(suiInput({ ...nearCapExtra, workState: { code: 'MI', certificate: {} } }));
      assert.equal(amountOf(r, 'MI_SUI_ER'), dollars(8.1));
    });

    test('employer explicitly marked qualified: reduced $9,000 base — already exceeded by YTD, $0 room left', () => {
      const r = calculatePaycheck(
        suiInput({
          ...nearCapExtra,
          workState: { code: 'MI', certificate: {} },
          employer: { stateUnemploymentQualifiedForReducedWageBase: { MI: true } },
        }),
      );
      assert.equal(amountOf(r, 'MI_SUI_ER'), dollars(0));
    });

    test('employer explicitly marked NOT qualified: same as the default, $9,500 base ($8.10)', () => {
      const r = calculatePaycheck(
        suiInput({
          ...nearCapExtra,
          workState: { code: 'MI', certificate: {} },
          employer: { stateUnemploymentQualifiedForReducedWageBase: { MI: false } },
        }),
      );
      assert.equal(amountOf(r, 'MI_SUI_ER'), dollars(8.1));
    });
  });
});

/**
 * Flat supplemental-wage rates for the states whose withholding method had
 * no supplemental branch of its own. Rates below are the real published
 * ones: Ohio 2.75% (separately legislated, not the bracket rate), Rhode
 * Island 5.99%, Missouri 4.7%, Nebraska 3.5%.
 */
describe('flat supplemental wages beyond the five methods that already had it', () => {
  const BONUS = [{ code: 'BON', category: 'supplemental' as const, amount: dollars(5000) }];
  const MIXED = [
    { code: 'REG', category: 'regular' as const, amount: dollars(3000) },
    { code: 'BON', category: 'supplemental' as const, amount: dollars(5000) },
  ];
  const supp = (earnings: typeof BONUS, extra: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings,
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    ...extra,
  });

  test("Ohio's separately-legislated 2.75% applies to a bonus paid on its own cheque", () => {
    const r = calculatePaycheck(supp(BONUS, { workState: { code: 'OH', certificate: {} } }));
    assert.equal(amountOf(r, 'OH_SIT_SUPP'), dollars(137.5));
  });

  test('...and the bonus is carved out of the regular base, not taxed twice', () => {
    // The defect this guards against is real: New Mexico shipped it once,
    // taxing a bonus through both the bracket table and the flat rate.
    const r = calculatePaycheck(supp(BONUS, { workState: { code: 'OH', certificate: {} } }));
    assert.equal(amountOf(r, 'OH_SIT'), dollars(0));
  });

  test('a bonus paid WITH regular wages is aggregated instead — no flat line at all', () => {
    const r = calculatePaycheck(supp(MIXED, { workState: { code: 'OH', certificate: {} } }));
    assert.equal(r.taxes.some((t) => t.id === 'OH_SIT_SUPP'), false);
    assert.ok(amountOf(r, 'OH_SIT') > dollars(0));
  });

  test("Rhode Island's 5.99% supplemental rate computes", () => {
    const r = calculatePaycheck(supp(BONUS, { workState: { code: 'RI', certificate: {} } }));
    assert.equal(amountOf(r, 'RI_SIT_SUPP'), dollars(299.5));
  });

  test('a state that only PERMITS the flat method does nothing until the employer elects it', () => {
    const aggregated = calculatePaycheck(supp(BONUS, { workState: { code: 'MO', certificate: {} } }));
    assert.equal(aggregated.taxes.some((t) => t.id === 'MO_SIT_SUPP'), false);
    assert.ok(amountOf(aggregated, 'MO_SIT') > dollars(0));

    const elected = calculatePaycheck(
      supp(BONUS, {
        workState: { code: 'MO', certificate: {} },
        employer: { supplementalFlatRateElection: { MO: true } },
      }),
    );
    assert.equal(amountOf(elected, 'MO_SIT_SUPP'), dollars(235.0));
    assert.equal(amountOf(elected, 'MO_SIT'), dollars(0));
  });

  test("Nebraska's elected 3.5% is its own figure, not its top marginal rate", () => {
    const r = calculatePaycheck(
      supp(BONUS, {
        workState: { code: 'NE', certificate: {} },
        employer: { supplementalFlatRateElection: { NE: true } },
      }),
    );
    assert.equal(amountOf(r, 'NE_SIT_SUPP'), dollars(175.0));
  });

  test("a state whose rule is 'always' is untouched by the paid-separately gate", () => {
    // New York's 11.70% predates this distinction and carries no
    // appliesWhen, so a bonus riding along with regular wages still gets it.
    const r = calculatePaycheck(supp(MIXED, { workState: { code: 'NY', certificate: {} } }));
    assert.equal(amountOf(r, 'NY_SIT_SUPP'), dollars(585.0));
  });
});

/**
 * The two paid-leave programmes whose shape the shared employer function
 * couldn't express: DC's, which has no employer-size threshold at all, and
 * Delaware's, whose premium depends on headcount and whose employee share
 * exists only if the employer elects to recover it.
 */
describe('paid leave where the employer, not the employee, is the payer of record', () => {
  const leave = (extra: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(3000) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    ...extra,
  });

  test("DC's Universal Paid Leave computes with no liability assertion — it has no size threshold", () => {
    const r = calculatePaycheck(leave({ workState: { code: 'DC', certificate: {} } }));
    assert.equal(amountOf(r, 'DC_PFML_ER'), dollars(22.5));
    assert.equal(r.taxes.find((t) => t.id === 'DC_PFML_ER')?.payer, 'employer');
    // 100% employer-funded: nothing is withheld from the employee.
    assert.equal(r.taxes.some((t) => t.id === 'DC_PFML_EE'), false);
  });

  test('a size-gated programme still waits for the caller to assert liability', () => {
    // Colorado's FAMLI employer share applies at 10+ employees; without that
    // determination there is no employer line, exactly as before.
    const r = calculatePaycheck(leave({ workState: { code: 'CO', certificate: {} } }));
    assert.equal(r.taxes.some((t) => t.id === 'CO_PFML_ER'), false);
  });

  test('Delaware computes nothing until the employer names its coverage tier', () => {
    const r = calculatePaycheck(leave({ workState: { code: 'DE', certificate: {} } }));
    assert.equal(r.taxes.some((t) => t.id.startsWith('DE_PFML')), false);
  });

  test('a Delaware employer with 1-9 employees is outside the Act entirely', () => {
    const r = calculatePaycheck(
      leave({ workState: { code: 'DE', certificate: {} }, employer: { paidLeaveTier: { DE: 'exempt' } } }),
    );
    assert.equal(r.taxes.some((t) => t.id.startsWith('DE_PFML')), false);
  });

  test('10-24 employees owe the parental component only, 25+ owe all three', () => {
    const parental = calculatePaycheck(
      leave({ workState: { code: 'DE', certificate: {} }, employer: { paidLeaveTier: { DE: 'parentalOnly' } } }),
    );
    assert.equal(amountOf(parental, 'DE_PFML_ER'), dollars(9.6)); // 0.32%

    const full = calculatePaycheck(
      leave({ workState: { code: 'DE', certificate: {} }, employer: { paidLeaveTier: { DE: 'full' } } }),
    );
    assert.equal(amountOf(full, 'DE_PFML_ER'), dollars(24.0)); // 0.80%
  });

  test('an employer electing to recover half splits the premium, and the employee line appears', () => {
    const r = calculatePaycheck(
      leave({
        workState: { code: 'DE', certificate: {} },
        employer: { paidLeaveTier: { DE: 'full' }, paidLeaveEmployeeShareFraction: { DE: 0.5 } },
      }),
    );
    assert.equal(amountOf(r, 'DE_PFML_EE'), dollars(12.0));
    assert.equal(amountOf(r, 'DE_PFML_ER'), dollars(12.0));
  });

  test("an election above the statute's ceiling is clamped, not obeyed", () => {
    const r = calculatePaycheck(
      leave({
        workState: { code: 'DE', certificate: {} },
        employer: { paidLeaveTier: { DE: 'full' }, paidLeaveEmployeeShareFraction: { DE: 0.9 } },
      }),
    );
    // Delaware permits recovering up to HALF; 90% is not a thing an employer
    // may do, so the employee still bears exactly half.
    assert.equal(amountOf(r, 'DE_PFML_EE'), dollars(12.0));
    assert.equal(amountOf(r, 'DE_PFML_ER'), dollars(12.0));
  });

  // The wage base is the "ssWageBase" sentinel (data/states/DE-2026.json),
  // resolved live from data/federal/2026.json's own socialSecurity.wageBase
  // rather than a hand-copied literal — closed 2026-09-06 alongside the
  // same fix for WA/CT/MA/ME. This exercised a real regression along the
  // way: statePaidLeaveElectedEmployeeShare() (the function that computes
  // DE_PFML_EE specifically, since Delaware has no separate
  // statePaidLeaveEmployee config) still read cfg.wageBase raw and had to
  // be updated to use the same resolver — caught immediately by this
  // describe block's own existing tests going from a real dollar amount to
  // $0 the moment the JSON switched to the sentinel string.
  test('DE_PFML wage base tracks the live federal SS cap: $500 of room left at $184,000 YTD', () => {
    const r = calculatePaycheck(
      leave({
        workState: { code: 'DE', certificate: {} },
        employer: { paidLeaveTier: { DE: 'full' }, paidLeaveEmployeeShareFraction: { DE: 0.5 } },
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, statePaidLeave: { DE: dollars(184000) } },
      }),
    );
    // $500 of room under the $184,500 SS-linked cap: total premium
    // 500 x 0.8% = $4.00, split 50/50 -> $2.00 employee, $2.00 employer.
    assert.equal(amountOf(r, 'DE_PFML_EE'), dollars(2.0));
    assert.equal(amountOf(r, 'DE_PFML_ER'), dollars(2.0));
  });
});

/**
 * Nonresident day-count de minimis. Every threshold below is the real one,
 * and the boundaries are deliberately tested from both sides because the
 * states phrase them differently: Alabama and Illinois exempt "fewer
 * than 31" days (so 30 is the last exempt day), New Mexico exempts "15 or
 * fewer" (so 15 itself is exempt), Montana "fewer than 30" (29).
 */
describe('nonresident day-count de minimis', () => {
  const away = (state: string, cert: Record<string, unknown>, residence: string | null) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(3000) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    workState: { code: state, certificate: cert },
    ...(residence ? { residenceState: { code: residence, certificate: {} } } : {}),
  });

  test('a nonresident under the threshold owes nothing, and the line says why', () => {
    const r = calculatePaycheck(away('AL', { daysWorkedInStateThisYear: 20 }, 'GA'));
    assert.equal(amountOf(r, 'AL_SIT'), dollars(0));
    assert.match(r.taxes.find((t) => t.id === 'AL_SIT')?.detail ?? '', /day-count de minimis/);
  });

  test('Alabama exempts at 30 days and taxes at 31 — "fewer than 31"', () => {
    assert.equal(amountOf(calculatePaycheck(away('AL', { daysWorkedInStateThisYear: 30 }, 'GA')), 'AL_SIT'), dollars(0));
    assert.ok(amountOf(calculatePaycheck(away('AL', { daysWorkedInStateThisYear: 31 }, 'GA')), 'AL_SIT') > dollars(0));
  });

  test('New Mexico exempts AT 15 days, not below it — "15 or fewer"', () => {
    assert.equal(amountOf(calculatePaycheck(away('NM', { daysWorkedInStateThisYear: 15 }, 'TX')), 'NM_SIT'), dollars(0));
    assert.ok(amountOf(calculatePaycheck(away('NM', { daysWorkedInStateThisYear: 16 }, 'TX')), 'NM_SIT') > dollars(0));
  });

  test('Montana exempts at 29 and taxes at 30 — "fewer than 30"', () => {
    const eligible = { daysWorkedInStateThisYear: 29, nonresidentDeMinimisEligible: true };
    assert.equal(amountOf(calculatePaycheck(away('MT', eligible, 'ID')), 'MT_SIT'), dollars(0));
    assert.ok(
      amountOf(
        calculatePaycheck(away('MT', { ...eligible, daysWorkedInStateThisYear: 30 }, 'ID')),
        'MT_SIT',
      ) > dollars(0),
    );
  });

  test('a missing day count withholds — absence is not a claim of few days', () => {
    assert.ok(amountOf(calculatePaycheck(away('AL', {}, 'GA')), 'AL_SIT') > dollars(0));
  });

  test('a resident is unaffected: no residence state, no de minimis', () => {
    assert.ok(amountOf(calculatePaycheck(away('AL', { daysWorkedInStateThisYear: 5 }, null)), 'AL_SIT') > dollars(0));
  });

  test('states whose statute adds unverifiable conditions wait for the caller to assert them', () => {
    // Indiana's exemption is conditioned on the employer running a
    // time-and-attendance system that records work location.
    const withoutAssertion = calculatePaycheck(
      away('IN', { county: 'Marion', daysWorkedInStateThisYear: 20 }, 'TX'),
    );
    assert.ok(amountOf(withoutAssertion, 'IN_SIT') > dollars(0));

    const withAssertion = calculatePaycheck(
      away('IN', { county: 'Marion', daysWorkedInStateThisYear: 20, nonresidentDeMinimisEligible: true }, 'TX'),
    );
    assert.equal(amountOf(withAssertion, 'IN_SIT'), dollars(0));
  });

  test("Indiana's rule reaches the county tax, which reciprocity deliberately does not", () => {
    const dayCount = calculatePaycheck(
      away('IN', { county: 'Marion', daysWorkedInStateThisYear: 20, nonresidentDeMinimisEligible: true }, 'TX'),
    );
    assert.equal(amountOf(dayCount, 'IN_COUNTY'), dollars(0));

    // An Ohio resident is exempt from Indiana STATE tax by reciprocity, but
    // Indiana county tax still applies — the split Indiana's own guidance
    // draws, and the reason dayCountAlsoExempts exists as a separate field.
    const reciprocal = calculatePaycheck(away('IN', { county: 'Marion' }, 'OH'));
    assert.equal(amountOf(reciprocal, 'IN_SIT'), dollars(0));
    assert.ok(amountOf(reciprocal, 'IN_COUNTY') > dollars(0));
  });

  test('the day-count rule STACKS with reciprocity — a reciprocal-state resident who ALSO qualifies is never worse off than a non-reciprocal one', () => {
    // BUG FIXED (found during manual cross-state testing, 2026-09-06):
    // day-count used to be skipped entirely whenever reciprocity already
    // exempted the state line, so a Kentucky resident (on IN's own
    // reciprocalStates list) who independently satisfied the SAME 30-day/
    // employer-eligibility facts as the TX resident above stayed stuck
    // paying full Indiana county tax — strictly worse off than a resident
    // of a state with NO relationship to Indiana at all, for identical
    // day-count facts. Day-count is a genuinely separate legal basis
    // (Departmental Notice #1 applies to any nonresident, not just a
    // reciprocalStates resident) and must be checked independently of
    // whether reciprocity already fired.
    const kyWithDayCount = calculatePaycheck(
      away('IN', { county: 'Marion', daysWorkedInStateThisYear: 10, nonresidentDeMinimisEligible: true }, 'KY'),
    );
    assert.equal(amountOf(kyWithDayCount, 'IN_SIT'), dollars(0));
    assert.equal(amountOf(kyWithDayCount, 'IN_COUNTY'), dollars(0));

    // Unchanged: a reciprocal-state resident who does NOT separately supply
    // day-count facts still gets only the narrower reciprocity treatment —
    // this fix adds a path, it doesn't grant an exemption nobody claimed.
    const kyPlainReciprocity = calculatePaycheck(away('IN', { county: 'Marion' }, 'KY'));
    assert.equal(amountOf(kyPlainReciprocity, 'IN_SIT'), dollars(0));
    assert.ok(amountOf(kyPlainReciprocity, 'IN_COUNTY') > dollars(0));
  });
});

/**
 * Nonresident allocation — the same arithmetic in three states, with three
 * genuinely different definitions of the fraction: Connecticut's share of
 * SERVICES (CT-W4NA), Vermont's share of HOURS, Delaware's share of
 * SOURCE INCOME over federal AGI (W-4NR).
 */
describe('nonresident allocation of state income tax', () => {
  const allocated = (state: string, cert: Record<string, unknown>, residence: string | null) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(3000) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    workState: { code: state, certificate: cert },
    ...(residence ? { residenceState: { code: residence, certificate: {} } } : {}),
  });

  test('Connecticut withholds only the share of services performed there', () => {
    const full = calculatePaycheck(allocated('CT', { withholdingCode: 'F' }, 'NY'));
    const part = calculatePaycheck(
      allocated('CT', { withholdingCode: 'F', nonresidentAllocationFraction: 0.4 }, 'NY'),
    );
    assert.equal(amountOf(full, 'CT_SIT'), dollars(140.96));
    assert.equal(amountOf(part, 'CT_SIT'), dollars(56.38));
    assert.match(part.taxes.find((t) => t.id === 'CT_SIT')?.detail ?? '', /CT-W4NA/);
  });

  test('a RESIDENT is never allocated, whatever fraction is supplied', () => {
    const r = calculatePaycheck(
      allocated('CT', { withholdingCode: 'F', nonresidentAllocationFraction: 0.4 }, null),
    );
    assert.equal(amountOf(r, 'CT_SIT'), dollars(140.96));
  });

  test('no fraction means no allocation — the full state tax stands', () => {
    const r = calculatePaycheck(allocated('CT', { withholdingCode: 'F' }, 'NY'));
    assert.equal(amountOf(r, 'CT_SIT'), dollars(140.96));
  });

  test('a fraction of 1 or more changes nothing, and a nonsense value is ignored', () => {
    const whole = calculatePaycheck(
      allocated('CT', { withholdingCode: 'F', nonresidentAllocationFraction: 1 }, 'NY'),
    );
    const nonsense = calculatePaycheck(
      allocated('CT', { withholdingCode: 'F', nonresidentAllocationFraction: 'most of it' }, 'NY'),
    );
    assert.equal(amountOf(whole, 'CT_SIT'), dollars(140.96));
    assert.equal(amountOf(nonsense, 'CT_SIT'), dollars(140.96));
  });

  test("each state's line names its OWN basis, not a generic percentage", () => {
    const vt = calculatePaycheck(allocated('VT', { nonresidentAllocationFraction: 0.25 }, 'NH'));
    assert.match(vt.taxes.find((t) => t.id === 'VT_SIT')?.detail ?? '', /hours worked in-state/);

    const de = calculatePaycheck(allocated('DE', { nonresidentAllocationFraction: 0.6 }, 'PA'));
    assert.match(de.taxes.find((t) => t.id === 'DE_SIT')?.detail ?? '', /source income over federal AGI/);
  });
});

/**
 * Colorado's other Occupational Privilege Tax cities. Denver was modelled
 * first and alone; Glendale, Greenwood Village and Sheridan levy their own
 * head tax, and Aurora levied one until repealing it effective 2025-01-01.
 * The three live cities do not agree on the threshold test, which is real
 * money for someone near it.
 */
describe('Colorado Occupational Privilege Tax beyond Denver', () => {
  const opt = (cert: Record<string, unknown>) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(2000) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    workState: { code: 'CO', certificate: cert },
  });

  test('Denver is unchanged by the generalization, old certificate field and all', () => {
    const modern = calculatePaycheck(
      opt({ locality: 'Denver', localMonthlyCompensation: dollars(4000) }),
    );
    assert.equal(amountOf(modern, 'DENVER_OPT_EE'), dollars(5.75));
    assert.equal(amountOf(modern, 'DENVER_OPT_ER'), dollars(4.0));

    const legacy = calculatePaycheck(
      opt({ locality: 'Denver', denverMonthlyCompensation: dollars(4000) }),
    );
    assert.equal(amountOf(legacy, 'DENVER_OPT_EE'), dollars(5.75));
  });

  test('Glendale taxes MORE THAN $750, so exactly $750 owes nothing', () => {
    const atThreshold = calculatePaycheck(
      opt({ locality: 'Glendale', localMonthlyCompensation: dollars(750) }),
    );
    assert.equal(amountOf(atThreshold, 'GLENDALE_OPT_EE'), dollars(0));

    const above = calculatePaycheck(
      opt({ locality: 'Glendale', localMonthlyCompensation: dollars(750.01) }),
    );
    assert.equal(amountOf(above, 'GLENDALE_OPT_EE'), dollars(5.0));
    assert.equal(amountOf(above, 'GLENDALE_OPT_ER'), dollars(5.0));
  });

  test('Greenwood Village taxes AT $250 — the opposite boundary from Glendale', () => {
    const atThreshold = calculatePaycheck(
      opt({ locality: 'Greenwood Village', localMonthlyCompensation: dollars(250) }),
    );
    assert.equal(amountOf(atThreshold, 'GREENWOOD_VILLAGE_OPT_EE'), dollars(2.0));
    assert.equal(amountOf(atThreshold, 'GREENWOOD_VILLAGE_OPT_ER'), dollars(2.0));

    const below = calculatePaycheck(
      opt({ locality: 'Greenwood Village', localMonthlyCompensation: dollars(249) }),
    );
    assert.equal(amountOf(below, 'GREENWOOD_VILLAGE_OPT_EE'), dollars(0));
  });

  test('Sheridan publishes no threshold, so the tax is due for each employee', () => {
    const r = calculatePaycheck(opt({ locality: 'Sheridan', localMonthlyCompensation: dollars(50) }));
    assert.equal(amountOf(r, 'SHERIDAN_OPT_EE'), dollars(3.0));
    assert.equal(amountOf(r, 'SHERIDAN_OPT_ER'), dollars(3.0));
    assert.match(r.taxes.find((t) => t.id === 'SHERIDAN_OPT_EE')?.detail ?? '', /publishes no monthly earnings threshold/);
  });

  test("Aurora's repealed tax computes nothing for a 2026 cheque", () => {
    const r = calculatePaycheck(opt({ locality: 'Aurora', localMonthlyCompensation: dollars(4000) }));
    assert.equal(r.taxes.some((t) => t.id.startsWith('AURORA_OPT')), false);
  });

  test('a flat monthly amount is never withheld twice in the same month', () => {
    const r = calculatePaycheck(opt({ locality: 'Sheridan', localOPTWithheldThisMonth: true }));
    assert.equal(amountOf(r, 'SHERIDAN_OPT_EE'), dollars(0));
  });
});

/**
 * Employment categories the Code taxes differently. The IRS is explicit on
 * both: a minister's earnings for services in the exercise of the ministry
 * are "not subject to income, social security, and Medicare tax
 * withholding" and those services are outside FUTA employment, while a
 * statutory employee is the mirror image — no income tax withholding, but
 * social security and Medicare ARE withheld.
 */
describe('clergy and statutory employees', () => {
  const worker = (extra: Record<string, unknown> = {}, w4extra: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(3000) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
      ...w4extra,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    ...extra,
  });

  test('an ordinary employee is untouched by the category logic', () => {
    const r = calculatePaycheck(worker());
    assert.equal(amountOf(r, 'US_FIT'), dollars(320.38));
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(186.0));
    assert.equal(amountOf(r, 'US_FUTA'), dollars(18.0));
  });

  test('a minister owes no federal withholding of any kind', () => {
    const r = calculatePaycheck(worker({ employmentCategory: 'clergy' }));
    for (const id of ['US_FIT', 'US_SS_EE', 'US_SS_ER', 'US_MED_EE', 'US_MED_ER', 'US_FUTA']) {
      assert.equal(amountOf(r, id), dollars(0), `${id} should be zero for clergy`);
    }
    // Zero LINES, not missing ones: a register that simply omits social
    // security looks identical to one that forgot it.
    assert.match(r.taxes.find((t) => t.id === 'US_SS_EE')?.detail ?? '', /SECA/);
  });

  test('a voluntary agreement restores income tax withholding, and only that', () => {
    const r = calculatePaycheck(
      worker({ employmentCategory: 'clergy' }, { voluntaryWithholdingAgreement: true }),
    );
    assert.equal(amountOf(r, 'US_FIT'), dollars(320.38));
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(0));
    assert.equal(amountOf(r, 'US_FUTA'), dollars(0));
  });

  test('a statutory employee is the mirror image: FICA yes, income tax no', () => {
    const r = calculatePaycheck(worker({ employmentCategory: 'statutory_employee' }));
    assert.equal(amountOf(r, 'US_FIT'), dollars(0));
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(186.0));
    assert.equal(amountOf(r, 'US_MED_EE'), dollars(43.5));
    assert.equal(amountOf(r, 'US_FUTA'), dollars(18.0));
    assert.match(r.taxes.find((t) => t.id === 'US_FIT')?.detail ?? '', /common-law/);
  });

  test('the flag reaches supplemental income tax too, not just the regular line', () => {
    const r = calculatePaycheck(
      worker({
        employmentCategory: 'statutory_employee',
        earnings: [{ code: 'BON', category: 'supplemental' as const, amount: dollars(5000) }],
      }),
    );
    assert.equal(amountOf(r, 'US_FIT_SUPP'), dollars(0));
    assert.ok(amountOf(r, 'US_SS_EE') > dollars(0));
  });
});

/**
 * Supplemental wages, AGGREGATION method — combine a separately-paid bonus
 * with the most recent regular payment, tax the total, subtract what was
 * already withheld. Seven state files disclosed this as unreachable
 * because a paycheck-at-a-time engine cannot look back; the prior payment
 * now arrives as input.priorRegularPayment.
 */
describe('supplemental wages aggregated with a prior regular payment', () => {
  const bonusOnly = (state: string, extra: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'BON', category: 'supplemental' as const, amount: dollars(5000) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    workState: { code: state, certificate: state === 'CT' ? { withholdingCode: 'F' } : {} },
    ...extra,
  });

  test('the prior payment raises the base and its withholding is credited back', () => {
    const alone = calculatePaycheck(bonusOnly('KY'));
    const aggregated = calculatePaycheck(
      bonusOnly('KY', {
        priorRegularPayment: { taxableWages: dollars(3000), stateIncomeTaxWithheld: dollars(120) },
      }),
    );
    assert.equal(amountOf(alone, 'KY_SIT'), dollars(170.48));
    assert.equal(amountOf(aggregated, 'KY_SIT'), dollars(155.48));
    assert.match(aggregated.taxes.find((t) => t.id === 'KY_SIT')?.detail ?? '', /aggregated with the prior regular payment/);
  });

  test('withholding already collected can absorb the whole liability — the line floors at zero', () => {
    const r = calculatePaycheck(
      bonusOnly('KY', {
        priorRegularPayment: { taxableWages: dollars(3000), stateIncomeTaxWithheld: dollars(9999) },
      }),
    );
    assert.equal(amountOf(r, 'KY_SIT'), dollars(0));
  });

  test('without a prior payment nothing changes — the bonus is taxed on its own', () => {
    const r = calculatePaycheck(bonusOnly('KY'));
    assert.equal(amountOf(r, 'KY_SIT'), dollars(170.48));
  });

  test('a bonus paid WITH regular wages is not aggregated twice', () => {
    // It already aggregates naturally: both earnings are in the same cheque.
    const r = calculatePaycheck(
      bonusOnly('KY', {
        earnings: [
          { code: 'REG', category: 'regular' as const, amount: dollars(3000) },
          { code: 'BON', category: 'supplemental' as const, amount: dollars(5000) },
        ],
        priorRegularPayment: { taxableWages: dollars(3000), stateIncomeTaxWithheld: dollars(120) },
      }),
    );
    // $3,000 + $5,000 taxed as one $8,000 payment, with no credit for the prior
    // cheque's withholding — that credit belongs to the separate-cheque case only.
    assert.equal(amountOf(r, 'KY_SIT'), dollars(275.48));
    assert.doesNotMatch(r.taxes.find((t) => t.id === 'KY_SIT')?.detail ?? '', /aggregated with the prior regular payment/);
  });

  test('an employer that elected the flat method gets the flat method, not aggregation', () => {
    const elected = calculatePaycheck(
      bonusOnly('MO', {
        priorRegularPayment: { taxableWages: dollars(3000), stateIncomeTaxWithheld: dollars(100) },
        employer: { supplementalFlatRateElection: { MO: true } },
      }),
    );
    assert.equal(amountOf(elected, 'MO_SIT_SUPP'), dollars(235.0));
    assert.equal(amountOf(elected, 'MO_SIT'), dollars(0));

    const notElected = calculatePaycheck(
      bonusOnly('MO', {
        priorRegularPayment: { taxableWages: dollars(3000), stateIncomeTaxWithheld: dollars(100) },
      }),
    );
    assert.equal(amountOf(notElected, 'MO_SIT'), dollars(240.0));
    assert.equal(notElected.taxes.some((t) => t.id === 'MO_SIT_SUPP'), false);
  });

  test('a state that does not publish this method ignores the prior payment entirely', () => {
    const withPrior = calculatePaycheck(
      bonusOnly('OH', {
        priorRegularPayment: { taxableWages: dollars(3000), stateIncomeTaxWithheld: dollars(80) },
      }),
    );
    // Ohio publishes a flat 2.75% for separately-paid supplemental wages.
    assert.equal(amountOf(withPrior, 'OH_SIT_SUPP'), dollars(137.5));
  });
});

/**
 * Household and agricultural workers. Neither is taxed at a different
 * RATE — ordinary FICA and FUTA apply — so the whole question is whether
 * the worker is inside the system yet. 2026 figures: $3,000 of cash wages
 * for domestic employment, $1,000 in a quarter for its FUTA, and either
 * $150 to one farmworker or $2,500 across all of them for farm work.
 */
describe('household and agricultural coverage thresholds', () => {
  const paid = (wage: number, extra: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(wage) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    ...extra,
  });

  test('a household worker under the coverage threshold owes no FICA at all', () => {
    const r = calculatePaycheck(
      paid(600, {
        employmentCategory: 'household',
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, categoryCashWages: dollars(600) },
      }),
    );
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(0));
    assert.match(r.taxes.find((t) => t.id === 'US_SS_EE')?.detail ?? '', /\$3000 coverage threshold/);
  });

  test('the cheque that crosses $3,000 turns FICA on', () => {
    const r = calculatePaycheck(
      paid(600, {
        employmentCategory: 'household',
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, categoryCashWages: dollars(2900) },
      }),
    );
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(37.2));
    assert.equal(amountOf(r, 'US_MED_EE'), dollars(8.7));
  });

  test('household FUTA has its own quarterly test, independent of FICA coverage', () => {
    const covered = {
      employmentCategory: 'household',
      ytd: { socialSecurity: 0, medicare: 0, futa: 0, categoryCashWages: dollars(2900) },
    };
    const withoutQuarter = calculatePaycheck(paid(600, covered));
    assert.equal(amountOf(withoutQuarter, 'US_FUTA'), dollars(0));

    const withQuarter = calculatePaycheck(
      paid(600, { ...covered, employer: { householdQuarterlyCashWages: dollars(1200) } }),
    );
    assert.equal(amountOf(withQuarter, 'US_FUTA'), dollars(3.6));
  });

  test('income tax is never withheld from a household employee unless both sides agree', () => {
    const withheld = {
      employmentCategory: 'household',
      ytd: { socialSecurity: 0, medicare: 0, futa: 0, categoryCashWages: dollars(5000) },
    };
    assert.equal(amountOf(calculatePaycheck(paid(3000, withheld)), 'US_FIT'), dollars(0));

    const voluntary = calculatePaycheck({
      ...paid(3000, withheld),
      federalW4: {
        filingStatus: 'single' as const,
        multipleJobs: false,
        dependentCredit: 0,
        otherIncome: 0,
        deductions: 0,
        extraWithholding: 0,
        voluntaryWithholdingAgreement: true,
      },
    });
    assert.equal(amountOf(voluntary, 'US_FIT'), dollars(320.38));
  });

  test('a farmworker under BOTH tests owes nothing', () => {
    const r = calculatePaycheck(paid(100, { employmentCategory: 'agricultural' }));
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(0));
    assert.equal(amountOf(r, 'US_FIT'), dollars(0));
  });

  test('either agricultural test alone is enough — $150 to this worker...', () => {
    const r = calculatePaycheck(
      paid(100, {
        employmentCategory: 'agricultural',
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, categoryCashWages: dollars(80) },
      }),
    );
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(6.2));
  });

  test('...or $2,500 across the whole farm, however little this worker earned', () => {
    const r = calculatePaycheck(
      paid(100, {
        employmentCategory: 'agricultural',
        employer: { agriculturalTotalWages: dollars(2500) },
      }),
    );
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(6.2));
  });

  test('agricultural FUTA waits for the employer to assert its own test', () => {
    const without = calculatePaycheck(paid(3000, { employmentCategory: 'agricultural' }));
    assert.equal(amountOf(without, 'US_FUTA'), dollars(0));

    const asserted = calculatePaycheck(
      paid(3000, { employmentCategory: 'agricultural', employer: { agriculturalFutaLiable: true } }),
    );
    assert.equal(amountOf(asserted, 'US_FUTA'), dollars(18.0));
  });

  test('a covered farmworker DOES have income tax withheld, unlike a household employee', () => {
    const r = calculatePaycheck(paid(3000, { employmentCategory: 'agricultural' }));
    assert.equal(amountOf(r, 'US_FIT'), dollars(320.38));
  });
});

/**
 * Covered rail employment, taxed under the Railroad Retirement Tax Act
 * instead of FICA. 2026 figures from the Railroad Retirement Board: Tier I
 * identical to social security and Medicare, Tier II at 4.9% employee and
 * 13.1% employer on compensation up to $137,100.
 */
describe('railroad retirement (RRTA)', () => {
  const rail = (extra: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(4000) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    ...extra,
  });

  test('Tier I is the same money as FICA, under its own name', () => {
    const standard = calculatePaycheck(rail());
    const railroad = calculatePaycheck(rail({ employmentCategory: 'railroad' }));

    assert.equal(amountOf(railroad, 'US_RRTA_TIER1_EE'), amountOf(standard, 'US_SS_EE'));
    assert.equal(amountOf(railroad, 'US_RRTA_MED_EE'), amountOf(standard, 'US_MED_EE'));
    // The FICA-named lines are gone: a rail employee does not pay them.
    assert.equal(railroad.taxes.some((t) => t.id === 'US_SS_EE'), false);
    assert.match(railroad.taxes.find((t) => t.id === 'US_RRTA_TIER1_EE')?.detail ?? '', /Form CT-1/);
  });

  test('Tier II is genuinely additional, and the employer pays nearly three times the employee', () => {
    const r = calculatePaycheck(rail({ employmentCategory: 'railroad' }));
    assert.equal(amountOf(r, 'US_RRTA_TIER2_EE'), dollars(196.0)); // 4.9%
    assert.equal(amountOf(r, 'US_RRTA_TIER2_ER'), dollars(524.0)); // 13.1%
  });

  test("Tier II's wage base runs out long before social security's", () => {
    const r = calculatePaycheck(
      rail({
        employmentCategory: 'railroad',
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, tier2Compensation: dollars(136000) },
      }),
    );
    // Only $1,100 of this $4,000 cheque is still under the $137,100 base.
    assert.equal(amountOf(r, 'US_RRTA_TIER2_EE'), dollars(53.9));
    assert.equal(amountOf(r, 'US_RRTA_TIER2_ER'), dollars(144.1));
    // Tier I keeps going: its base is $184,500.
    assert.equal(amountOf(r, 'US_RRTA_TIER1_EE'), dollars(248.0));
  });

  test('rail employment is outside FUTA — railroad employers pay under the RUIA instead', () => {
    const r = calculatePaycheck(rail({ employmentCategory: 'railroad' }));
    assert.equal(amountOf(r, 'US_FUTA'), dollars(0));
    assert.match(r.taxes.find((t) => t.id === 'US_FUTA')?.detail ?? '', /Railroad Unemployment Insurance Act/);
  });

  test('income tax withholding is unaffected — rail wages are ordinary wages for that', () => {
    const standard = calculatePaycheck(rail());
    const railroad = calculatePaycheck(rail({ employmentCategory: 'railroad' }));
    assert.equal(amountOf(railroad, 'US_FIT'), amountOf(standard, 'US_FIT'));
  });
});

/**
 * Kentucky county occupational tax, now complete. Every county that levies
 * one is present with a rate confirmed against the Kentucky Association of
 * Counties own 2025 payroll-rate column — including 25 counties that were
 * missing from this project's original scrape entirely.
 */
describe('Kentucky county occupational tax coverage', () => {
  const ky = (cert: Record<string, unknown>) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(3000) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    workState: { code: 'KY', certificate: cert },
  });

  test('a county confirmed from the KACo payroll column computes at its own rate', () => {
    assert.equal(amountOf(calculatePaycheck(ky({ workCounty: 'Adair County' })), 'KY_LOCAL'), dollars(15.0));
    assert.equal(amountOf(calculatePaycheck(ky({ workCounty: 'Allen County' })), 'KY_LOCAL'), dollars(30.0));
  });

  test('a county absent from the original scrape now computes too', () => {
    // Ballard, Boone, Hardin and 22 others were simply not in the scraped
    // list; they came from KACo's table outright.
    assert.equal(amountOf(calculatePaycheck(ky({ workCounty: 'Ballard County' })), 'KY_LOCAL'), dollars(45.0));
    assert.equal(amountOf(calculatePaycheck(ky({ workCounty: 'Boone County' })), 'KY_LOCAL'), dollars(24.0));
    assert.equal(amountOf(calculatePaycheck(ky({ workCounty: 'Hardin County' })), 'KY_LOCAL'), dollars(30.0));
  });

  test('every Kentucky county on file carries a usable rate', () => {
    const file = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'data', 'local', 'KY-occupational-2026.json'), 'utf8'),
    );
    const counties = file.jurisdictions.scraped.filter((e: { name: string }) => / County$/.test(e.name));
    assert.equal(counties.length, 87);
    const withRate = counties.filter((e: { wageRateDecimal: number | null }) => typeof e.wageRateDecimal === 'number');
    assert.equal(withRate.length, 87, 'every county entry should carry a confirmed payroll rate');
  });

  test('a city and its county still stack, with the KRS 68.197 credit', () => {
    // Edmonton 1.5% (its own payroll form; was 1% until 2026-09-28) fully
    // credits Metcalfe County's 1%, so only the city's amount is owed.
    const r = calculatePaycheck(ky({ workCity: 'Edmonton', workCounty: 'Metcalfe County' }));
    assert.equal(amountOf(r, 'KY_LOCAL'), dollars(45.0));
    assert.match(r.taxes.find((t) => t.id === 'KY_LOCAL')?.detail ?? '', /Edmonton/);
  });
});

/**
 * Election workers and railroad unemployment — the two remaining federal
 * categories. 2026 figures: election workers come into social security and
 * Medicare at $2,500 of pay, and RUIA contributions run 0.65% to 12.0%
 * with a 5.58% new-employer rate on $2,150 of compensation per MONTH.
 */
describe('election workers and railroad unemployment', () => {
  const fed = (wage: number, extra: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(wage) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    ...extra,
  });

  test('an election worker under $2,500 is outside social security entirely', () => {
    const r = calculatePaycheck(fed(400, { employmentCategory: 'election_worker' }));
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(0));
    assert.equal(amountOf(r, 'US_MED_EE'), dollars(0));
  });

  test('crossing $2,500 brings them in', () => {
    const r = calculatePaycheck(
      fed(400, {
        employmentCategory: 'election_worker',
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, categoryCashWages: dollars(2200) },
      }),
    );
    assert.equal(amountOf(r, 'US_SS_EE'), dollars(24.8));
    assert.equal(amountOf(r, 'US_MED_EE'), dollars(5.8));
  });

  test('election work is outside FUTA however much is paid — there is no threshold to cross', () => {
    const r = calculatePaycheck(
      fed(400, {
        employmentCategory: 'election_worker',
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, categoryCashWages: dollars(50000) },
      }),
    );
    assert.equal(amountOf(r, 'US_FUTA'), dollars(0));
    assert.match(r.taxes.find((t) => t.id === 'US_FUTA')?.detail ?? '', /state or local government/);
  });

  test('no income tax is withheld from an election worker unless they ask', () => {
    const covered = {
      employmentCategory: 'election_worker',
      ytd: { socialSecurity: 0, medicare: 0, futa: 0, categoryCashWages: dollars(5000) },
    };
    assert.equal(amountOf(calculatePaycheck(fed(3000, covered)), 'US_FIT'), dollars(0));

    const requested = calculatePaycheck({
      ...fed(3000, covered),
      federalW4: {
        filingStatus: 'single' as const,
        multipleJobs: false,
        dependentCredit: 0,
        otherIncome: 0,
        deductions: 0,
        extraWithholding: 0,
        voluntaryWithholdingAgreement: true,
      },
    });
    assert.equal(amountOf(requested, 'US_FIT'), dollars(320.38));
  });

  test('a rail employer pays RUIA instead of FUTA, at the new-employer rate by default', () => {
    const r = calculatePaycheck(fed(4000, { employmentCategory: 'railroad' }));
    // $2,150 monthly base at 5.58%.
    assert.equal(amountOf(r, 'US_RUIA_ER'), dollars(119.97));
    assert.equal(amountOf(r, 'US_FUTA'), dollars(0));
  });

  test('RUIA caps by CALENDAR MONTH, not by year', () => {
    const r = calculatePaycheck(
      fed(4000, {
        employmentCategory: 'railroad',
        ytd: { socialSecurity: 0, medicare: 0, futa: 0, railroadMonthlyCompensation: dollars(2000) },
      }),
    );
    // Only $150 of the $2,150 monthly base is left.
    assert.equal(amountOf(r, 'US_RUIA_ER'), dollars(8.37));
  });

  test("an employer's own experience rate replaces the default", () => {
    const r = calculatePaycheck(
      fed(4000, { employmentCategory: 'railroad', employer: { railroadUnemploymentRate: 0.0065 } }),
    );
    // 0.65% is the floor, which 91% of covered rail employers actually pay.
    assert.equal(amountOf(r, 'US_RUIA_ER'), dollars(13.98));
    assert.match(r.taxes.find((t) => t.id === 'US_RUIA_ER')?.detail ?? '', /own experience-rated/);
  });
});

/**
 * A minister's designated housing allowance: cash that is excluded from
 * income tax but still paid. The exclusion belongs to the minister, not to
 * the earning code — a category name is not a tax exemption.
 */
describe("ministers' housing allowance", () => {
  const withAllowance = (extra: Record<string, unknown> = {}, w4: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [
      { code: 'REG', category: 'regular' as const, amount: dollars(2000) },
      { code: 'HOUS', category: 'housing_allowance' as const, amount: dollars(1000) },
    ],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
      ...w4,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    ...extra,
  });

  test('for anyone who is not a minister it is ordinary taxable pay', () => {
    const r = calculatePaycheck(withAllowance());
    // Same tax as $3,000 of plain wages.
    assert.equal(amountOf(r, 'US_FIT'), dollars(320.38));
  });

  test('for a minister it leaves the income tax base', () => {
    const r = calculatePaycheck(
      withAllowance({ employmentCategory: 'clergy' }, { voluntaryWithholdingAgreement: true }),
    );
    // Tax computed on the $2,000 of ordinary pay only.
    assert.equal(amountOf(r, 'US_FIT'), dollars(156.15));
  });

  test('it is still paid — gross and net both include it', () => {
    const r = calculatePaycheck(withAllowance({ employmentCategory: 'clergy' }));
    assert.equal(r.grossPay, dollars(3000));
    assert.equal(r.netPay, dollars(3000));
  });
});

/**
 * FUTA credit reduction — the reason "FUTA is 0.6%" is only true in states
 * that repaid their federal unemployment loans. Driven from synthetic
 * rulesets rather than the shipped 2026 file, because the shipped file
 * correctly carries an EMPTY map: the year's determination is made after
 * November 10 and did not exist when it was written.
 */
describe('FUTA credit reduction', () => {
  const earnings = [{ code: 'REG', category: 'regular' as const, amount: dollars(3000) }];
  const ctx = {
    year: 2026,
    periodsPerYear: 26,
    taxableWagesFor: makeTaxableWagesFn(earnings, []),
  };
  const futaInput = (state: string) =>
    ({
      checkDate: '2026-08-15',
      payFrequency: 'biweekly',
      earnings,
      deductions: [],
      federalW4: {
        filingStatus: 'single',
        multipleJobs: false,
        dependentCredit: 0,
        otherIncome: 0,
        deductions: 0,
        extraWithholding: 0,
      },
      ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
      workState: { code: state, certificate: {} },
    }) as unknown as PaycheckInput;
  const futaRules = (states: Record<string, number>) =>
    ({
      futa: {
        grossRate: 0.06,
        standardCredit: 0.054,
        netRate: 0.006,
        wageBase: 7000,
        exemptPretax: [],
        creditReduction: { states, determinationDate: '2026-11-10' },
      },
    }) as never;

  test('an undetermined year withholds the ordinary 0.6% and says the determination is pending', () => {
    const line = futa(futaInput('OH'), ctx, futaRules({}))[0];
    assert.equal(line.amount, dollars(18.0));
    assert.match(line.detail ?? '', /determination is made after 2026-11-10/);
  });

  test("a reduced state pays more — California's 1.2% reduction makes it 1.8%", () => {
    const line = futa(futaInput('CA'), ctx, futaRules({ CA: 0.012 }))[0];
    assert.equal(line.amount, dollars(54.0));
    assert.match(line.detail ?? '', /1\.2% credit reduction/);
  });

  test('the Virgin Islands 4.5% reduction makes it 5.1% — eight and a half times the headline rate', () => {
    const line = futa(futaInput('VI'), ctx, futaRules({ VI: 0.045 }))[0];
    assert.equal(line.amount, dollars(153.0));
  });

  test('a state NOT on the list is untouched by one that is', () => {
    const line = futa(futaInput('OH'), ctx, futaRules({ CA: 0.012 }))[0];
    assert.equal(line.amount, dollars(18.0));
    // The pending wording must not appear once a determination exists.
    assert.equal(/determination is made after/.test(line.detail ?? ''), false);
  });

  test('the shipped 2026 ruleset carries an EMPTY map, not a copy of last year', () => {
    const federal = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'data', 'federal', '2026.json'), 'utf8'),
    );
    assert.deepEqual(federal.futa.creditReduction.states, {});
    // Last year's finals are kept as reference, never as a substitute.
    assert.equal(federal.futa.creditReduction.priorYear.year, 2025);
    assert.equal(federal.futa.creditReduction.priorYear.states.CA, 0.012);
  });
});

/**
 * Seattle's JumpStart payroll expense tax — an employer levy banded on two
 * axes at once: how big the employer is, and how much the individual
 * employee earns. 2026 figures: liable at $9,074,409 of prior-year Seattle
 * payroll, taxable above $194,452 per employee, upper band from $518,538,
 * rates 0.746% to 2.557%.
 */
describe('Seattle payroll expense tax (JumpStart)', () => {
  const seattle = (wage: number, ytdComp: number | null, priorPayroll: number | null) => ({
    checkDate: '2026-08-15',
    payFrequency: 'semimonthly' as const,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(wage) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: {
      socialSecurity: 0,
      medicare: 0,
      futa: 0,
      ...(ytdComp !== null ? { seattleCompensation: dollars(ytdComp) } : {}),
    },
    workState: { code: 'WA', certificate: { locality: 'Seattle' } },
    ...(priorPayroll !== null
      ? { employer: { seattlePriorYearPayrollExpense: dollars(priorPayroll) } }
      : {}),
  });
  const hasLine = (r: ReturnType<typeof calculatePaycheck>) =>
    r.taxes.some((t) => t.id === 'SEATTLE_PAYROLL_ER');

  test('computes nothing without the employer payroll figure — it cannot be inferred from a paycheck', () => {
    assert.equal(hasLine(calculatePaycheck(seattle(10000, 0, null))), false);
  });

  test('an employer under the payroll threshold owes nothing', () => {
    assert.equal(hasLine(calculatePaycheck(seattle(10000, 0, 5000000))), false);
  });

  test('a liable employer owes nothing on an employee under the compensation threshold', () => {
    assert.equal(hasLine(calculatePaycheck(seattle(10000, 100000, 20000000))), false);
  });

  test('only the part of the cheque above $194,452 is taxed', () => {
    // $190,000 already paid + $10,000 now: $5,548 sits above the threshold.
    const r = calculatePaycheck(seattle(10000, 190000, 20000000));
    assert.equal(amountOf(r, 'SEATTLE_PAYROLL_ER'), dollars(41.39));
  });

  test("the employer's own size changes the rate on identical wages", () => {
    const midsize = calculatePaycheck(seattle(10000, 250000, 20000000));
    const giant = calculatePaycheck(seattle(10000, 250000, 2000000000));
    assert.equal(amountOf(midsize, 'SEATTLE_PAYROLL_ER'), dollars(74.6)); // 0.746%
    assert.equal(amountOf(giant, 'SEATTLE_PAYROLL_ER'), dollars(149.2)); // 1.492%
  });

  test('a cheque spanning the $518,538 boundary is split across both bands', () => {
    // $515,000 already paid + $10,000 now: $3,538 in the lower band at
    // 0.746%, $6,462 in the upper at 1.811%.
    const r = calculatePaycheck(seattle(10000, 515000, 20000000));
    assert.equal(amountOf(r, 'SEATTLE_PAYROLL_ER'), dollars(143.42));
  });

  test('it is an employer cost — nothing is withheld from the employee', () => {
    const r = calculatePaycheck(seattle(10000, 600000, 20000000));
    const line = r.taxes.find((t) => t.id === 'SEATTLE_PAYROLL_ER');
    assert.equal(line?.payer, 'employer');
    assert.equal(amountOf(r, 'SEATTLE_PAYROLL_ER'), dollars(181.1));
  });
});

/**
 * Montana's supplemental Methods 1 and 2, and New Mexico's dollar-a-month
 * floor — the last two state-level mechanisms that were documented in the
 * data and had nowhere to run.
 */
describe('Montana Methods 1/2 and the New Mexico monthly floor', () => {
  const mt = (extra: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    payFrequency: 'biweekly' as const,
    earnings: [{ code: 'BON', category: 'supplemental' as const, amount: dollars(5000) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    workState: { code: 'MT', certificate: {} },
    ...extra,
  });

  test('a Montana bonus with no prior cheque falls to Method 3, the flat 5%', () => {
    const r = calculatePaycheck(mt());
    assert.equal(amountOf(r, 'MT_SIT_SUPP'), dollars(250.0));
  });

  test('with the prior regular cheque supplied, Methods 1/2 tax the combined amount', () => {
    // $5,000 bonus + $3,000 prior = $8,000, which Montana's own table taxes
    // at $400; less the $120 already withheld from that prior cheque.
    const r = calculatePaycheck(
      mt({ priorRegularPayment: { taxableWages: dollars(3000), stateIncomeTaxWithheld: dollars(120) } }),
    );
    assert.equal(amountOf(r, 'MT_SIT'), dollars(280.0));
  });

  test('...and the flat Method 3 line stands down — the methods are alternatives, not partners', () => {
    const r = calculatePaycheck(
      mt({ priorRegularPayment: { taxableWages: dollars(3000), stateIncomeTaxWithheld: dollars(120) } }),
    );
    assert.equal(r.taxes.some((t) => t.id === 'MT_SIT_SUPP'), false);
  });

  const nm = (wage: number, frequency: 'weekly' | 'monthly', cert: Record<string, unknown> = {}) => ({
    checkDate: '2026-08-15',
    payFrequency: frequency,
    earnings: [{ code: 'REG', category: 'regular' as const, amount: dollars(wage) }],
    deductions: [],
    federalW4: {
      filingStatus: 'single' as const,
      multipleJobs: false,
      dependentCredit: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    workState: { code: 'NM', certificate: cert },
  });

  test('New Mexico waives a month whose withholding comes to less than a dollar', () => {
    // $700 monthly sits just past the 0% band: 1.5% of $29 is $0.44,
    // which New Mexico does not require anyone to withhold.
    const r = calculatePaycheck(nm(700, 'monthly'));
    assert.equal(amountOf(r, 'NM_SIT'), dollars(0));
    assert.match(r.taxes.find((t) => t.id === 'NM_SIT')?.detail ?? '', /less than \$1\.00/);
  });

  test('a WEEKLY cheque under a dollar is still withheld — one cheque is not a month', () => {
    // $0.68 a week is $2.72 a month, well over the floor. Waiving it on the
    // strength of a single cheque would under-withhold all year.
    const r = calculatePaycheck(nm(200, 'weekly'));
    assert.equal(amountOf(r, 'NM_SIT'), dollars(0.68));
  });

  test("...unless the caller supplies the month's running total and it is still under a dollar", () => {
    const r = calculatePaycheck(nm(15, 'weekly', { stateTaxWithheldThisMonth: dollars(0.1) }));
    assert.equal(amountOf(r, 'NM_SIT'), dollars(0));
  });

  test('an ordinary New Mexico wage is untouched by the floor', () => {
    const r = calculatePaycheck(nm(3000, 'monthly'));
    assert.ok(amountOf(r, 'NM_SIT') > dollars(50));
  });
});

describe('Voluntary / nexus-based residence-state withholding', () => {
  // NY works in every fixture below because data/states/NY-2026.json's own
  // reciprocity.reciprocalStates is confirmed empty (NY has no reciprocity
  // agreements with any state) — that isolates these tests from the
  // reciprocityExemptionReason() gate, which must NOT fire here so it's
  // clear residenceStateWithholdingLine() is what's actually being tested.
  const nyWorkingMiResiding = (residenceStateWithholding: PaycheckInput['residenceStateWithholding']) =>
    input({
      workState: { code: 'NY' },
      residenceState: { code: 'MI', certificate: { allowances: 1 } },
      residenceStateWithholding,
    });

  test('no election at all: no residence-state line, same as before this feature existed', () => {
    const r = calculatePaycheck(nyWorkingMiResiding(undefined));
    assert.equal(r.taxes.find((t) => t.id === 'MI_SIT_RESIDENCE'), undefined);
  });

  test('nexus: withholds MI tax on the same wages NY already taxed, using MI\'s own certificate', () => {
    const r = calculatePaycheck(nyWorkingMiResiding({ nexus: true }));
    // Same math as the Michigan describe block above: biweekly $3,000 →
    // annual 78,000 − 5,900 = 72,100 × 4.25% = 3,064.25/yr ÷ 26 = 117.86.
    assert.equal(amountOf(r, 'MI_SIT_RESIDENCE'), dollars(117.86));
    assert.match(r.taxes.find((t) => t.id === 'MI_SIT_RESIDENCE')?.name ?? '', /^Michigan Income Tax \(residence state\)$/);
    // NY's own work-state tax is untouched — this is additive, not a swap.
    assert.ok(amountOf(r, 'NY_SIT') > 0);
  });

  test('voluntary (no nexus): same tax amount as nexus, but labelled as a courtesy election', () => {
    const r = calculatePaycheck(nyWorkingMiResiding({ voluntary: true }));
    assert.equal(amountOf(r, 'MI_SIT_RESIDENCE'), dollars(117.86));
    const line = r.taxes.find((t) => t.id === 'MI_SIT_RESIDENCE');
    assert.match(line?.name ?? '', /voluntary/);
    assert.match(line?.detail ?? '', /voluntarily agreed/);
  });

  test('nexus: false and voluntary: false explicitly set is the same as no election at all', () => {
    const r = calculatePaycheck(nyWorkingMiResiding({ nexus: false, voluntary: false }));
    assert.equal(r.taxes.find((t) => t.id === 'MI_SIT_RESIDENCE'), undefined);
  });

  test('same state on both sides never fires, regardless of the election', () => {
    const r = calculatePaycheck(
      input({
        workState: { code: 'MI', certificate: { allowances: 1 } },
        residenceState: { code: 'MI', certificate: { allowances: 1 } },
        residenceStateWithholding: { nexus: true },
      }),
    );
    assert.equal(r.taxes.find((t) => t.id === 'MI_SIT_RESIDENCE'), undefined);
  });

  test('a mandatory reciprocity exemption takes precedence over a caller-elected courtesy', () => {
    // MI/OH have an actual reciprocal agreement (MI-2026.json's own
    // reciprocity.reciprocalStates includes OH), so an OH resident working
    // in MI already gets MI_SIT zeroed by reciprocityExemptionReason() —
    // that mandatory, statute-driven mechanism must win even if the caller
    // also asserts residenceStateWithholding.voluntary for the same period.
    const r = calculatePaycheck(
      input({
        workState: { code: 'MI', certificate: { allowances: 1 } },
        residenceState: { code: 'OH' },
        residenceStateWithholding: { voluntary: true },
      }),
    );
    assert.equal(amountOf(r, 'MI_SIT'), 0);
    assert.equal(r.taxes.find((t) => t.id === 'OH_SIT_RESIDENCE'), undefined);
  });
});

// Which pre-tax deductions reduce each local wage base. Ohio municipal
// "qualifying wages" (ORC 718.01(R)) start from Medicare wages and add
// 401(k)/403(b)/457 employee deferrals back, but deduct Section 125
// amounts. JEDD/JEDZ taxes are "subject to Chapter 718" (ORC 715.72,
// 715.691) and share that base. Ohio school district tax is defined by
// Ohio modified AGI (ORC 5748.01(E)), so a deferral DOES reduce it, for
// traditional and earned-income districts alike. Pennsylvania taxes
// deferrals as compensation, so they don't reduce PA EIT either. All
// fixtures: $3,000.00 biweekly; rates are the real ones from data/local/.
describe('local wage bases with pre-tax deductions', () => {
  const k401: Deduction = { code: '401K', category: 'deferral_401k', amount: dollars(240) };
  const cafeteria: Deduction = { code: 'MED', category: 'section125', amount: dollars(200) };
  const line = (r: ReturnType<typeof calculatePaycheck>, id: string) => {
    const t = r.taxes.find((x) => x.id === id);
    assert.ok(t, `expected a tax line with id ${id}`);
    return t;
  };
  const columbus = { code: 'OH', certificate: { residenceCity: 'Columbus', workCity: 'Columbus' } };

  test('Ohio municipal: a 401(k) deferral does not reduce the base (Columbus 2.5% of $3,000 = $75.00)', () => {
    const r = calculatePaycheck(input({ deductions: [k401], workState: columbus }));
    assert.equal(line(r, 'OH_LOCAL').taxableWages, dollars(3000));
    assert.equal(amountOf(r, 'OH_LOCAL'), dollars(75.0));
    // The state tax on the same paycheck still excludes the deferral.
    assert.equal(line(r, 'OH_SIT').taxableWages, dollars(2760));
  });

  test('Ohio municipal: 403(b) and 457 deferrals are added back too', () => {
    for (const category of ['deferral_403b', 'deferral_457'] as const) {
      const r = calculatePaycheck(
        input({ deductions: [{ code: 'RET', category, amount: dollars(240) }], workState: columbus }),
      );
      assert.equal(line(r, 'OH_LOCAL').taxableWages, dollars(3000), category);
    }
  });

  test('Ohio municipal: a Section 125 deduction does reduce the base ($2,800 x 2.5% = $70.00)', () => {
    const r = calculatePaycheck(input({ deductions: [cafeteria], workState: columbus }));
    assert.equal(line(r, 'OH_LOCAL').taxableWages, dollars(2800));
    assert.equal(amountOf(r, 'OH_LOCAL'), dollars(70.0));
  });

  test('Ohio municipal: with both, only the Section 125 amount comes off', () => {
    const r = calculatePaycheck(input({ deductions: [k401, cafeteria], workState: columbus }));
    assert.equal(line(r, 'OH_LOCAL').taxableWages, dollars(2800));
    assert.equal(amountOf(r, 'OH_LOCAL'), dollars(70.0));
  });

  test('Ohio municipal: the work/home credit uses the same base (Cincinnati 1.8% home, Columbus 2.5% work)', () => {
    // Work tax 3,000 x 2.5% = 75.00; home tax 3,000 x 1.8% = 54.00, fully credited.
    const r = calculatePaycheck(
      input({
        deductions: [k401],
        workState: { code: 'OH', certificate: { residenceCity: 'Cincinnati', workCity: 'Columbus' } },
      }),
    );
    assert.equal(amountOf(r, 'OH_LOCAL'), dollars(75.0));
  });

  test('JEDD/JEDZ: same base as municipal tax (Bath-Akron-Fairlawn JEDD 2.5%)', () => {
    const jedd = { code: 'OH', certificate: { workJEDDId: '9004' } };
    const withDeferral = calculatePaycheck(input({ deductions: [k401], workState: jedd }));
    assert.equal(line(withDeferral, 'OH_JEDD').taxableWages, dollars(3000));
    assert.equal(amountOf(withDeferral, 'OH_JEDD'), dollars(75.0));
    const withCafeteria = calculatePaycheck(input({ deductions: [cafeteria], workState: jedd }));
    assert.equal(amountOf(withCafeteria, 'OH_JEDD'), dollars(70.0));
  });

  test('Ohio school district: a 401(k) deferral DOES reduce the base, for both base types (1.0% of $2,760 = $27.60)', () => {
    // 6901 Columbus Grove LSD is a traditional-base district, 0502 Athens
    // CSD an earned-income-base one; both are 1.0% and both use Ohio MAGI.
    for (const sd of ['6901', '0502']) {
      const r = calculatePaycheck(
        input({ deductions: [k401], workState: { code: 'OH', certificate: { schoolDistrictCode: sd } } }),
      );
      assert.equal(line(r, 'OH_SDIT').taxableWages, dollars(2760), sd);
      assert.equal(amountOf(r, 'OH_SDIT'), dollars(27.6), sd);
    }
  });

  test('Pennsylvania EIT: a 401(k) deferral does not reduce the base, Section 125 does (PSD 700102, 3.0%)', () => {
    const pgh = { code: 'PA', certificate: { workPSD: '700102', residencePSD: '700102' } };
    const withDeferral = calculatePaycheck(input({ deductions: [k401], workState: pgh }));
    assert.equal(line(withDeferral, 'PA_EIT').taxableWages, dollars(3000));
    assert.equal(amountOf(withDeferral, 'PA_EIT'), dollars(90.0));
    const withCafeteria = calculatePaycheck(input({ deductions: [cafeteria], workState: pgh }));
    assert.equal(amountOf(withCafeteria, 'PA_EIT'), dollars(84.0)); // 2,800 x 3.0%
  });
});
