import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { readFileSync } from 'node:fs';
import { UnsupportedTaxYearError, setDataReader, statesWithRuleset } from '../src/registry.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * Tax year 2025: federal rules from Pub 15-T (2025) and the nine states
 * with no wage income tax. A 2025 check for any other state is refused,
 * never computed federal-only.
 */

const pay = (checkDate: string, state: string, residence?: string): PaycheckInput => ({
  checkDate,
  payFrequency: 'biweekly',
  earnings: [{ code: 'REG', category: 'regular', amount: 300000 }], // $3,000
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: state } as PaycheckInput['workState'],
  ...(residence ? { residenceState: { code: residence } as PaycheckInput['residenceState'] } : {}),
});
const amount = (r: ReturnType<typeof calculatePaycheck>, id: string) => r.taxes.find((t) => t.id === id)?.amount;

describe('tax year 2025', () => {
  test('covers federal and the states with a 2025 file', () => {
    const covered = statesWithRuleset('2025-06-13');
    for (const st of ['AK', 'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY']) assert.ok(covered.includes(st), st);
  });

  test("Illinois 2025: IL-700-T's own example ($800 weekly, 2 + 2 allowances) withholds $32.27", () => {
    const r = calculatePaycheck({ ...pay('2025-06-13', 'IL'), payFrequency: 'weekly', earnings: [{ code: 'REG', category: 'regular', amount: 80000 }],
      workState: { code: 'IL', certificate: { basicAllowances: 2, additionalAllowances: 2 } } as PaycheckInput['workState'] });
    assert.equal(amount(r, 'IL_SIT'), 3227);
  });

  test('Georgia 2025 switches from 5.39% to 5.19% for checks from 1 July 2025', () => {
    const ga = (checkDate: string) => amount(calculatePaycheck({ ...pay(checkDate, 'GA'), payFrequency: 'semimonthly', earnings: [{ code: 'REG', category: 'regular', amount: 147083 }],
      workState: { code: 'GA', certificate: { filingStatus: 'C', dependents: 1 } } as PaycheckInput['workState'] }), 'GA_SIT');
    assert.equal(ga('2025-06-13'), 4334);
    assert.equal(ga('2025-08-15'), 4174);
  });

  const st = (checkDate: string, code: string, certificate: Record<string, unknown> = {}, payFrequency: PaycheckInput['payFrequency'] = 'biweekly', gross = 300000) =>
    calculatePaycheck({ ...pay(checkDate, code), payFrequency, earnings: [{ code: 'REG', category: 'regular', amount: gross }], workState: { code, certificate } as PaycheckInput['workState'] });

  test('Kentucky 2025: 4% after the $3,270 standard deduction ((78,000 - 3,270) x 4% / 26 = $114.97)', () => {
    assert.equal(amount(st('2025-06-13', 'KY'), 'KY_SIT'), 11497);
  });

  test("Iowa 2025: the formula's own Example 1 ($2,100 biweekly, Other, $40 allowance) withholds $60.72", () => {
    assert.equal(amount(st('2025-06-13', 'IA', { iaMaritalStatus: 'other', totalAllowanceAmount: 4000 }, 'biweekly', 210000), 'IA_SIT'), 6072);
  });

  test("Louisiana 2025: R-1306's own Example 1 ($700 weekly, Block A '1') withholds $14.20", () => {
    assert.equal(amount(st('2025-06-13', 'LA', { louisianaBlockA: 1 }, 'weekly', 70000), 'LA_SIT'), 1420);
  });

  test("Idaho 2025: its own example ($1,212 biweekly, 4 allowances) is $5 on the old table and $2 from 1 May", () => {
    assert.equal(amount(st('2025-03-14', 'ID', { allowances: 4 }, 'biweekly', 121200), 'ID_SIT'), 500);
    assert.equal(amount(st('2025-06-13', 'ID', { allowances: 4 }, 'biweekly', 121200), 'ID_SIT'), 200);
  });

  test('Utah 2025: 4.55% table before 1 June, 4.5% from then ($1,000 weekly single: $46, then $45)', () => {
    assert.equal(amount(st('2025-03-14', 'UT', {}, 'weekly', 100000), 'UT_SIT'), 4600);
    assert.equal(amount(st('2025-06-13', 'UT', {}, 'weekly', 100000), 'UT_SIT'), 4500);
  });

  test("Indiana 2025: Departmental Notice #1's own example ($800 weekly) withholds $14.19 state at 3%", () => {
    const r = st('2025-06-13', 'IN', { personalExemptions: 5, dependentExemptions: 3, firstTimeDependentExemptions: 1, adoptedChildExemptions: 2, county: 'Adams' }, 'weekly', 80000);
    assert.equal(amount(r, 'IN_SIT'), 1419);
    assert.equal(amount(r, 'IN_COUNTY'), 757); // Adams 1.6% x 473.08
  });

  test('North Carolina 2025 withholds at 4.35% ((3,000 - 12,750/26) x 4.35% = $109.17 -> $109)', () => {
    assert.equal(amount(st('2025-06-13', 'NC'), 'NC_SIT'), 10900);
  });

  test('Colorado 2025: $5,000 allowance at 4.4%, FAMLI 0.45% from the employee', () => {
    const r = st('2025-06-13', 'CO');
    assert.equal(amount(r, 'CO_SIT'), 12354); // (78,000 - 5,000) x 4.4% / 26
    assert.equal(amount(r, 'CO_PFML_EE'), 1350);
  });

  test('Mississippi 2025 taxes above $10,000 at 4.4%, 2026 at 4.0%', () => {
    assert.ok(amount(st('2025-06-13', 'MS'), 'MS_SIT')! > amount(st('2026-06-12', 'MS'), 'MS_SIT')!);
  });

  describe('Pennsylvania local rates by check date', () => {
    const eit = (checkDate: string, psd: string) =>
      amount(st(checkDate, 'PA', { workPSD: psd, residencePSD: psd }), 'PA_EIT');
    test('Philadelphia: 3.75% until 30 June 2025, 3.74% to 30 June 2026, then 3.735%', () => {
      assert.equal(eit('2025-06-13', '510101'), 11250);
      assert.equal(eit('2025-08-15', '510101'), 11220);
      assert.equal(eit('2026-03-13', '510101'), 11220);
      assert.equal(eit('2026-08-14', '510101'), 11205);
    });
    test("Springfield Twp (Delaware) has no municipal EIT until its new 1% starts on 1 July 2026", () => {
      assert.equal(eit('2026-03-13', '231202'), 0);
      assert.equal(eit('2026-08-14', '231202'), 3000);
    });
    test('South Canaan Twp: 0.5% from 1 April 2025', () => {
      assert.equal(eit('2025-03-14', '640205'), 0);
      assert.equal(eit('2025-06-13', '640205'), 1500);
    });
    test('Kingston Twp: 1.05% + 0.5% school in 2025, 1.34% + 0.5% in 2026', () => {
      assert.equal(eit('2025-06-13', '400204'), 4650);
      assert.equal(eit('2026-06-12', '400204'), 5520);
    });
  });

  test("California 2025 reproduces EDD Method B's own examples C, D and B", () => {
    assert.equal(amount(st('2025-06-13', 'CA', { filingStatus: 'married_one_income', regularAllowances: 5 }, 'monthly', 510000), 'CA_SIT'), 389);
    assert.equal(amount(st('2025-06-13', 'CA', { filingStatus: 'hoh', regularAllowances: 3 }, 'weekly', 95000), 'CA_SIT'), 220);
    assert.equal(amount(st('2025-06-13', 'CA', { filingStatus: 'married_one_income', regularAllowances: 2, estimatedDeductionAllowances: 1 }, 'biweekly', 160000), 'CA_SIT'), 328);
    assert.equal(amount(st('2025-06-13', 'CA', { filingStatus: 'hoh', regularAllowances: 3 }, 'weekly', 95000), 'CA_DBL_EE'), 1140); // SDI 1.2%
  });

  test("Missouri 2025: the formula's own example ($35,000 a year, married spouse works) is $64 a month", () => {
    assert.equal(amount(st('2025-06-13', 'MO', { filingStatus: 'married_spouse_works' }, 'monthly', 291667), 'MO_SIT'), 6400);
  });

  test("Oklahoma 2025: OW-2's own example ($1,825 semi-monthly, married, 2 allowances) is $42", () => {
    assert.equal(amount(st('2025-06-13', 'OK', { filingStatus: 'married', allowances: 2 }, 'semimonthly', 182500), 'OK_SIT'), 4200);
  });

  test("North Dakota 2025: the booklet's own example ($1,800 weekly, single, 2 pre-2020 allowances) is $10", () => {
    assert.equal(amount(st('2025-06-13', 'ND', { formVintage: 'pre_2020', maritalStatus: 'single', allowances: 2 }, 'weekly', 180000), 'ND_SIT'), 1000);
  });

  test("South Carolina 2025: WH-1603F's own example ($750 weekly, 3 allowances) is $11.44", () => {
    assert.equal(amount(st('2025-06-13', 'SC', { allowances: 3 }, 'weekly', 75000), 'SC_SIT'), 1144);
  });

  test('Nebraska 2025: $2,360 allowance and the 5.37% top bracket ($1,800 weekly, married, 2 allowances: $70.36)', () => {
    // 1,800 - 2 x 45.38 = 1,709.24; 61.22 + 5.37% x (1,709.24 - 1,539)
    assert.equal(amount(st('2025-06-13', 'NE', { maritalStatus: 'married', allowances: 2 }, 'weekly', 180000), 'NE_SIT'), 7036);
  });

  test("Vermont 2025: GB-1210's own example ($1,800 weekly, married, 2 allowances) is $46.07", () => {
    assert.equal(amount(st('2025-06-13', 'VT', { maritalStatus: 'married', allowances: 2 }, 'weekly', 180000), 'VT_SIT'), 4607);
  });

  test("Kansas 2025: KW-100's own example ($2,000 semi-monthly, joint, one dependent) is $41.44", () => {
    assert.equal(amount(st('2025-06-13', 'KS', { allowanceRate: 'joint', personalAllowances: 2, dependents: 1 }, 'semimonthly', 200000), 'KS_SIT'), 4144);
  });

  test("Maine 2025: the tables' own Example 2 ($1,000 weekly, single, 2 allowances) is $33", () => {
    assert.equal(amount(st('2025-06-13', 'ME', { maritalStatus: 'single', allowances: 2 }, 'weekly', 100000), 'ME_SIT'), 3300);
  });

  test('Minnesota 2025: $5,200 allowance, and no Paid Leave premium before 2026', () => {
    const r = st('2025-06-13', 'MN', { maritalStatus: 'single', allowances: 1 });
    assert.equal(amount(r, 'MN_SIT'), 16034); // (78,000 - 5,200): 1,742.50 + 6.8% x (72,800 - 37,120) = 4,168.74 / 26
    assert.equal(amount(r, 'MN_PFML_EE'), undefined);
  });

  test("Montana 2025 rounds UP, as the 2025 guide's own examples do ($130.16 -> $131, $35.25 -> $36, married $86.21 -> $87)", () => {
    assert.equal(amount(st('2025-06-13', 'MT', {}, 'biweekly', 295000), 'MT_SIT'), 13100);
    assert.equal(amount(st('2025-06-13', 'MT', {}, 'semimonthly', 137500), 'MT_SIT'), 3600);
    assert.equal(amount(st('2025-06-13', 'MT', { filingStatus: 'mfj' }, 'biweekly', 295000), 'MT_SIT'), 8700);
    assert.equal(amount(st('2026-06-12', 'MT', {}, 'semimonthly', 137500), 'MT_SIT'), 3300); // 2026 still rounds to nearest
  });

  test("New Mexico 2025: FYI-104's 2025 table, and the workers' comp fee rising on 1 July 2025", () => {
    const early = st('2025-03-14', 'NM', { filingStatus: 'married_joint' }, 'weekly', 100000);
    assert.equal(amount(early, 'NM_SIT'), 2270); // 12.77 + 4.3% x (1,000 - 769)
    assert.equal(amount(st('2025-03-14', 'NM', { filingStatus: 'married_joint' }, 'monthly', 400000), 'NM_WC_FEE_EE'), 67); // $2.00 / 3
    assert.equal(amount(st('2025-09-12', 'NM', { filingStatus: 'married_joint' }, 'monthly', 400000), 'NM_WC_FEE_EE'), 75); // $2.25 / 3
  });

  test('Oregon 2025: $2,835 standard deduction, $8,500 federal cap, $917 + 8.75% band, WBF 1.0 cent an hour each side', () => {
    const r = st('2025-06-13', 'OR', { filingStatus: 'single', allowances: 0 }, 'biweekly', 100000);
    // 26,000 - 1,100.06 federal - 2,835 = 22,064.94; 917 + 8.75% x (22,064.94 - 11,100) = 1,876.43 / 26
    assert.equal(amount(r, 'OR_SIT'), 7217);
    assert.equal(amount(r, 'OR_WBF_EE'), 80);
  });

  test('West Virginia: October 2024 tables through 2025 and until SB 392 took effect on 12 June 2026', () => {
    assert.equal(amount(st('2025-06-13', 'WV', { exemptions: 1 }, 'biweekly', 300000), 'WV_SIT'), 11700);
    assert.equal(amount(st('2026-03-13', 'WV', { exemptions: 1 }, 'biweekly', 300000), 'WV_SIT'), 11700);
    assert.equal(amount(st('2026-07-10', 'WV', { exemptions: 1 }, 'biweekly', 300000), 'WV_SIT'), 11100);
  });

  test('Wisconsin 2025 uses the same W-166 tables as 2026', () => {
    assert.equal(amount(st('2025-06-13', 'WI', { maritalStatus: 'single', exemptions: 1 }), 'WI_SIT'), amount(st('2026-06-12', 'WI', { maritalStatus: 'single', exemptions: 1 }), 'WI_SIT'));
  });

  test('Connecticut 2025 uses the same statutory tables as 2026', () => {
    assert.equal(amount(st('2025-06-13', 'CT', { withholdingCode: 'A' }), 'CT_SIT'), amount(st('2026-06-12', 'CT', { withholdingCode: 'A' }), 'CT_SIT'));
  });

  test('Hawaii 2025 TDI employee share is capped at $7.21 a week', () => {
    assert.equal(amount(st('2025-06-13', 'HI', {}, 'weekly', 200000), 'HI_DBL_EE'), 721);
  });

  test('Maryland 2025: 15% standard deduction ($2,800 cap) until July, then the flat $3,350', () => {
    const md = (d: string) => amount(st(d, 'MD', { filingStatus: 'single', exemptions: 1, county: 'Montgomery' }), 'MD_SIT');
    assert.equal(md('2025-03-14'), 22015); // (78,000 - 2,800 - 3,200) x (4.75% + 3.2%) / 26
    assert.equal(md('2025-08-15'), 21847); // (78,000 - 3,350 - 3,200) x 7.95% / 26
  });

  test('Rhode Island 2025 booklet example: $2,195 weekly, one exemption = $87.98; TDI 1.3%', () => {
    const r = st('2025-03-14', 'RI', { exemptions: 1 }, 'weekly', 219500);
    assert.equal(amount(r, 'RI_SIT'), 8798);
    assert.equal(amount(r, 'RI_DBL_EE'), 2854);
  });

  test('Arkansas 2025: $2,410 standard deduction, 3.9% top rate and the 200-wide midrange band', () => {
    // 25,524 - 2,410 = 23,114 -> 23,150 x 3.4% - 281.37 = 505.73 -> 506 - 2 x 29 = 448 / 12
    assert.equal(amount(st('2025-03-14', 'AR', { exemptions: 2 }, 'monthly', 212700), 'AR_SIT'), 3733);
    // 96,864 - 2,410 = 94,454 -> 94,450 x 3.9% - 197.40 (the $94,301-$94,501 band) = 3,486 / 12
    assert.equal(amount(st('2025-03-14', 'AR', { exemptions: 0 }, 'monthly', 807200), 'AR_SIT'), 29050);
  });

  test('Arkansas 2025 low-income election uses the credit formula', () => {
    // 176 gross less (1 - (15,600 - 14,266) / 2,734) x 109.20 = 55.92 credit, less 29 = 91.08 / 12
    const cert = { exemptions: 1, lowIncomeElection: true, filingStatus: 'single', dependents: 0 };
    assert.equal(amount(st('2025-03-14', 'AR', cert, 'monthly', 130000), 'AR_SIT'), 759);
    assert.equal(amount(st('2025-03-14', 'AR', cert, 'monthly', 110000), 'AR_SIT'), 0);
  });

  test('Alabama 2025: overtime is excluded through June 30, 2025, and Opelika is 1.5% until April', () => {
    const al = (d: string, ot: boolean) =>
      calculatePaycheck({
        ...pay(d, 'AL'),
        earnings: [
          { code: 'REG', category: 'regular', amount: 200000 },
          { code: 'OT', category: 'regular', amount: 30000, overtime: ot },
        ],
        workState: { code: 'AL', certificate: { alabamaExemptionCode: 'S', workCity: 'Opelika' } } as PaycheckInput['workState'],
      });
    // $300 overtime x 5% = $15.00 less Alabama tax while the exclusion runs
    assert.equal(amount(al('2025-03-14', false), 'AL_SIT') - amount(al('2025-03-14', true), 'AL_SIT'), 1500);
    assert.equal(amount(al('2025-08-15', true), 'AL_SIT'), amount(al('2025-08-15', false), 'AL_SIT'));
    assert.equal(amount(al('2025-03-14', true), 'AL_LOCAL'), 3450); // 2,300 x 1.5%
    assert.equal(amount(al('2025-08-15', true), 'AL_LOCAL'), 2300); // 1% from 2025-04-01
  });

  test('Virginia 2025 guide example ($2,649 semimonthly, 5 exemptions = $109.50); $8,500 deduction until July 1', () => {
    assert.equal(amount(st('2025-08-15', 'VA', { personalExemptions: 5 }, 'semimonthly', 264900), 'VA_SIT'), 10950);
    // (63,576 - 8,500 - 4,650 - 17,000) x 5.75% + 720 = 2,642.38, whole dollars as in the example, / 24
    assert.equal(amount(st('2025-03-14', 'VA', { personalExemptions: 5 }, 'semimonthly', 264900), 'VA_SIT'), 11008);
  });

  test('District of Columbia and Delaware 2025 match their unchanged 2026 formulas', () => {
    assert.equal(amount(st('2025-06-13', 'DC'), 'DC_SIT'), amount(st('2026-06-12', 'DC'), 'DC_SIT'));
    assert.equal(amount(st('2025-06-13', 'DC'), 'DC_PFML_ER'), 2250); // 0.75% since July 2024
    assert.equal(amount(st('2025-06-13', 'DE'), 'DE_SIT'), amount(st('2026-06-12', 'DE'), 'DE_SIT'));
  });

  test('New Jersey 2025 worker contributions: TDI 0.23%, FLI 0.33%, UI/WF 0.425%', () => {
    const r = st('2025-03-14', 'NJ');
    assert.equal(amount(r, 'NJ_DBL_EE'), 690);
    assert.equal(amount(r, 'NJ_PFML_EE'), 990);
    assert.equal(amount(r, 'NJ_UC_EE'), 1275);
  });

  test('New York 2025 uses NYS-50-T-NYS (1/22): all four single worked examples', () => {
    assert.equal(amount(st('2025-03-14', 'NY', { maritalStatus: 'single', exemptions: 3 }, 'weekly', 40000), 'NY_SIT'), 820);
    assert.equal(amount(st('2025-03-14', 'NY', { maritalStatus: 'single', exemptions: 1 }, 'semimonthly', 500000), 'NY_SIT'), 27573);
    assert.equal(amount(st('2025-03-14', 'NY', { maritalStatus: 'single', exemptions: 3 }, 'monthly', 5000000), 'NY_SIT'), 357613);
    assert.equal(amount(st('2025-03-14', 'NY', { maritalStatus: 'single', exemptions: 2 }, 'daily', 75000), 'NY_SIT'), 4658);
    // Paid Family Leave 0.388% in 2025
    assert.equal(amount(st('2025-03-14', 'NY', { maritalStatus: 'single', exemptions: 3 }, 'weekly', 40000), 'NY_PFML_EE'), 155);
  });

  test('Ohio 2025: July 2024 tables until October 1, 2025, then the October 2025 tables', () => {
    // 1,000 - 12.50 = 987.50; 5.78 + (987.50 - 384.62) x 2.990% = 23.81
    assert.equal(amount(st('2025-06-13', 'OH', { exemptions: 1 }, 'weekly', 100000), 'OH_SIT'), 2381);
    // 8.89 + (987.50 - 500.96) x 2.990% = 23.44
    assert.equal(amount(st('2025-10-03', 'OH', { exemptions: 1 }, 'weekly', 100000), 'OH_SIT'), 2344);
  });

  test('Ohio 2025 local: dated municipal rates, 2025 school districts and JEDDs', () => {
    const oh = (d: string, certificate: Record<string, unknown>) => st(d, 'OH', certificate, 'weekly', 100000);
    assert.equal(amount(oh('2025-06-13', { workCity: 'Circleville' }), 'OH_LOCAL'), 2000); // 2.0% in 2025, 2.5% from 2026
    assert.equal(amount(oh('2025-06-13', { workCity: 'Oak Hill' }), 'OH_LOCAL'), 500); // 0.5% until July 1
    assert.equal(amount(oh('2025-07-11', { workCity: 'Oak Hill' }), 'OH_LOCAL'), 1000);
    assert.equal(amount(oh('2025-06-13', { workCity: 'Paulding' }), 'OH_LOCAL'), 1100);
    assert.equal(amount(oh('2025-08-15', { workCity: 'North Hampton' }), 'OH_LOCAL'), 1000); // new July 2025
    assert.equal(amount(oh('2025-06-13', { schoolDistrictCode: '8701' }), 'OH_SDIT'), 500); // Bowling Green CSD 0.5% (1.25% in 2026)
    assert.equal(amount(oh('2025-06-13', { workJEDDId: '9080' }), 'OH_JEDD'), 1750); // Miami Twp-Dayton 1.75% (2.25% in 2026)
    assert.equal(st('2025-03-14', 'OH', { workJEDDId: '9147' }, 'weekly', 100000).taxes.find((t) => t.id === 'OH_JEDD'), undefined); // Milford 8 starts 2025-04-01
  });

  test('Michigan 2025: 4.25% after $5,800 per exemption', () => {
    // 3,000 - 5,800/26 = 2,776.92 x 4.25%
    const r = calculatePaycheck({ ...pay('2025-06-13', 'MI'), workState: { code: 'MI', certificate: { allowances: 1 } } as PaycheckInput['workState'] });
    assert.equal(amount(r, 'MI_SIT'), 11802);
  });

  test('federal income tax uses the 2025 tables ($3,000 biweekly single: $337.46)', () => {
    // 78,000 - 8,600 = 69,400; 5,578.50 + 22% x (69,400 - 54,875) = 8,774 / 26
    assert.equal(amount(calculatePaycheck(pay('2025-06-13', 'TX')), 'US_FIT'), 33746);
    // same cheque in 2026 uses the 2026 tables
    assert.equal(amount(calculatePaycheck(pay('2026-06-12', 'TX')), 'US_FIT'), 32038);
  });

  test('social security stops at the 2025 base of $176,100', () => {
    const r = calculatePaycheck({ ...pay('2025-12-19', 'FL'), ytd: { socialSecurity: 17500000, medicare: 17500000, futa: 700000 } });
    assert.equal(r.taxes.find((t) => t.id === 'US_SS_EE')?.taxableWages, 110000);
  });

  test('Washington 2025 paid leave: 0.92% x 71.52% employee share', () => {
    assert.equal(amount(calculatePaycheck(pay('2025-06-13', 'WA')), 'WA_PFML_EE'), 1974);
  });

  test('Alaska 2025 employee unemployment 0.5%, employer 1.5% on $51,700', () => {
    const r = calculatePaycheck(pay('2025-06-13', 'AK'));
    assert.equal(amount(r, 'AK_UC_EE'), 1500);
    assert.equal(amount(r, 'AK_SUI_ER'), 4500);
  });

  // Every state now has 2025 rules, so these hide one file behind the data reader.
  const withoutDataFile = (hidden: string, fn: () => void) => {
    const real = (rel: string) => {
      try {
        return readFileSync(new URL(`../data/${rel}`, import.meta.url), 'utf8');
      } catch {
        return undefined;
      }
    };
    setDataReader((rel) => (rel === hidden ? undefined : real(rel)));
    try {
      fn();
    } finally {
      setDataReader(real);
    }
  };

  test('a 2025 check in a state without 2025 rules is refused, not computed federal-only', () => {
    withoutDataFile('states/OH-2025.json', () =>
      assert.throws(() => calculatePaycheck(pay('2025-06-13', 'OH')), (e: unknown) => e instanceof UnsupportedTaxYearError && /OH/.test(e.message)),
    );
  });

  test('a 2025 check where only the residence state lacks 2025 rules is refused too', () => {
    withoutDataFile('states/NY-2025.json', () =>
      assert.throws(() => calculatePaycheck(pay('2025-06-13', 'WA', 'NY')), UnsupportedTaxYearError),
    );
  });

  test('a 2024 check is refused: no 2024 rules at all', () => {
    assert.throws(() => calculatePaycheck(pay('2024-06-14', 'TX')), UnsupportedTaxYearError);
  });
});
