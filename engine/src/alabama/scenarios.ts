import type { AlabamaPaycheckInput } from './types.ts';

/**
 * A catalogue of Alabama payroll scenarios this engine can now calculate,
 * each one exercising a genuinely different rule rather than a different
 * dollar amount of the same rule. Not a test suite — tests/engine.test.ts
 * already proves the arithmetic against the booklet's own worked examples
 * — this is a runnable reference for "can it do X", built for the pass that
 * added the 5% supplemental option, the severance exemption, the exempt
 * employment categories and the federal-law exemptions on top of the
 * existing formula/local-tax engine.
 *
 * Every scenario is a complete AlabamaPaycheckInput. Run one with
 * calculateAlabamaPaycheck() (or `npm run demo:alabama` for all of them at
 * once) and read the `alabama.explanation` / `warnings` arrays alongside
 * the numbers — that is the part a dollar figure alone doesn't show.
 */
export interface AlabamaScenario {
  id: string;
  title: string;
  /** What this scenario exists to prove the engine can do. */
  covers: string;
  input: AlabamaPaycheckInput;
}

export const ALABAMA_SCENARIOS: AlabamaScenario[] = [
  {
    id: 'plain-single',
    title: 'Ordinary weekly wages, single, no dependents, no A-4 on file',
    covers:
      "Baseline: no certificate at all defaults to code '0' with zero dependents, exactly as the " +
      'booklet instructs employers to do when an employee never submits a Form A-4.',
    input: {
      checkDate: '2026-03-13',
      payFrequency: 'weekly',
      earnings: { regular: 620 },
      federalW4: { filingStatus: 'single' },
    },
  },
  {
    id: 'married-with-dependents',
    title: "Weekly $850, 'M-2' — the booklet's own worked example",
    covers:
      "The married bracket schedule, the standard-deduction step function, and the annual-federal-" +
      "withholding subtraction, all at once — this is the booklet's own Formula example, page 6.",
    input: {
      checkDate: '2026-03-13',
      payFrequency: 'weekly',
      earnings: { regular: 850 },
      a4: { exemptionCode: 'M', dependents: 2 },
      federalW4: { filingStatus: 'married_joint' },
    },
  },
  {
    id: 'birmingham-occupational',
    title: 'Semimonthly salary, working in Birmingham',
    covers:
      "The AL_LOCAL municipal occupational tax (1% of gross, work-location-based) stacked on top of " +
      'the state formula, with no double-counting between the two.',
    input: {
      checkDate: '2026-04-15',
      payFrequency: 'semimonthly',
      earnings: { regular: 2600 },
      a4: { exemptionCode: 'H', dependents: 1 },
      federalW4: { filingStatus: 'head_of_household' },
      workCity: 'Birmingham',
    },
  },
  {
    id: 'city-not-taxing',
    title: 'Same salary, working in Montgomery',
    covers:
      'A work city that is a real Alabama city but NOT among those known to levy an occupational ' +
      'tax — correctly produces no local line at all, not a silent $0 assumption.',
    input: {
      checkDate: '2026-04-15',
      payFrequency: 'semimonthly',
      earnings: { regular: 2600 },
      a4: { exemptionCode: 'H', dependents: 1 },
      federalW4: { filingStatus: 'head_of_household' },
      workCity: 'Montgomery',
    },
  },
  {
    id: 'bonus-flat-five-percent',
    title: 'Standalone $5,000 bonus, employer elects the 5% flat method',
    covers:
      "Alabama's own published option — \"Employers may withhold state income tax from bonuses and " +
      'supplemental wage payments at the rate of 5%\" — an employer election this engine now honours.',
    input: {
      checkDate: '2026-06-01',
      payFrequency: 'biweekly',
      earnings: { bonus: 5000 },
      a4: { exemptionCode: 'S' },
      federalW4: { filingStatus: 'single' },
      employer: { useFivePercentSupplementalRate: true },
    },
  },
  {
    id: 'bonus-not-elected',
    title: 'Same $5,000 bonus, employer does NOT elect the flat method',
    covers:
      'The default path: the bonus is annualized through the ordinary formula and over-withholds, ' +
      'which is why this combination now raises an explicit warning rather than passing silently.',
    input: {
      checkDate: '2026-06-01',
      payFrequency: 'biweekly',
      earnings: { bonus: 5000 },
      a4: { exemptionCode: 'S' },
      federalW4: { filingStatus: 'single' },
    },
  },
  {
    id: 'severance-approved',
    title: '$18,000 severance, Department approval on file',
    covers:
      "The $50,000-per-employee severance exemption, wired end to end: caller asserts " +
      'severanceExemption.approvalOnFile, and the exempt amount leaves the taxable base before annualizing.',
    input: {
      checkDate: '2026-09-01',
      payFrequency: 'monthly',
      earnings: { regular: 6000, severance: 18000 },
      a4: { exemptionCode: '0' },
      federalW4: { filingStatus: 'single' },
      severanceExemption: { approvalOnFile: true },
    },
  },
  {
    id: 'severance-no-approval',
    title: 'Same $18,000 severance, NO Department approval on file',
    covers:
      'The conditional half of the same rule: without an asserted approval, severance is ordinary ' +
      'taxable wages, and the engine says exactly why in the tax line detail and in a warning.',
    input: {
      checkDate: '2026-09-01',
      payFrequency: 'monthly',
      earnings: { regular: 6000, severance: 18000 },
      a4: { exemptionCode: '0' },
      federalW4: { filingStatus: 'single' },
    },
  },
  {
    id: 'severance-partial-cap',
    title: '$42,000 severance after $15,000 already exempted this year',
    covers:
      'The per-employee ANNUAL cap, not a per-cheque one: only $35,000 of room remains, so the ' +
      'exemption is capped and the excess $7,000 is taxable, both reflected in the line detail.',
    input: {
      checkDate: '2026-10-01',
      payFrequency: 'monthly',
      earnings: { regular: 5000, severance: 42000 },
      a4: { exemptionCode: 'M', dependents: 1 },
      federalW4: { filingStatus: 'married_joint' },
      severanceExemption: { approvalOnFile: true, alreadyExemptedThisYear: 15000 },
    },
  },
  {
    id: 'household-employee',
    title: 'A private-home domestic worker, weekly $500',
    covers:
      "One of Alabama's own excluded classes of employment: \"the chief classes of exempt employment " +
      'are domestic services in private homes...\" — AL_SIT is zeroed by employmentCategory alone, ' +
      'independent of any A-4.',
    input: {
      checkDate: '2026-05-01',
      payFrequency: 'weekly',
      earnings: { regular: 500 },
      federalW4: { filingStatus: 'single' },
      employmentCategory: 'household',
    },
  },
  {
    id: 'agricultural-worker',
    title: 'A farmworker, weekly $400 — the case Alabama diverges from federal on',
    covers:
      'The parenthetical the booklet states explicitly: Alabama does NOT follow the federal rule that ' +
      "taxes agricultural cash wages once the $150/$2,500 tests are met. AL_SIT is $0 here even though " +
      'the same worker could owe federal income tax withholding on the same wages.',
    input: {
      checkDate: '2026-05-01',
      payFrequency: 'weekly',
      earnings: { regular: 400 },
      federalW4: { filingStatus: 'single' },
      employmentCategory: 'agricultural',
    },
  },
  {
    id: 'minister-housing-allowance',
    title: "A minister's paycheck with a $1,200 designated housing allowance",
    covers:
      "Alabama's clergy exclusion (employmentCategory zeroes AL_SIT) combined with the engine's own " +
      "housing-allowance exclusion (excluded from the FEDERAL base for clergy specifically), on the " +
      'same cheque.',
    input: {
      checkDate: '2026-07-01',
      payFrequency: 'monthly',
      earnings: { regular: 2800, housingAllowance: 1200 },
      federalW4: { filingStatus: 'married_joint' },
      employmentCategory: 'clergy',
    },
  },
  {
    id: 'nonresident-safe-harbor',
    title: 'Georgia resident, 12 days worked in Alabama this year',
    covers:
      "Act 2025-334's 30-day safe harbor: at or under 30 days, a nonresident owes $0 Alabama tax " +
      'however large the cheque, via the day-count mechanism this engine now applies to Alabama.',
    input: {
      checkDate: '2026-08-01',
      payFrequency: 'weekly',
      earnings: { regular: 1500 },
      federalW4: { filingStatus: 'single' },
      residency: { residenceState: 'GA', daysWorkedInAlabamaThisYear: 12 },
    },
  },
  {
    id: 'nonresident-over-threshold',
    title: 'Same Georgia resident, now at 45 days worked in Alabama',
    covers:
      "The other side of the same threshold: past 30 days, the full Alabama withholding applies — " +
      '"the income and withholdings are taxable and reportable to Alabama."',
    input: {
      checkDate: '2026-11-01',
      payFrequency: 'weekly',
      earnings: { regular: 1500 },
      federalW4: { filingStatus: 'single' },
      residency: { residenceState: 'GA', daysWorkedInAlabamaThisYear: 45 },
    },
  },
  {
    id: 'nonresident-partial-allocation',
    title: 'Tennessee resident past 30 days, only 60% of this period worked in Alabama',
    covers:
      '"...only to the extent that the wages are earned in Alabama" — the nonresident allocation ' +
      'fraction scales the AL_SIT line down to the in-state share once the safe harbor no longer applies.',
    input: {
      checkDate: '2026-09-15',
      payFrequency: 'biweekly',
      earnings: { regular: 3200 },
      federalW4: { filingStatus: 'single' },
      residency: { residenceState: 'TN', daysWorkedInAlabamaThisYear: 90, alabamaWorkFraction: 0.6 },
    },
  },
  {
    id: 'employee-claims-exempt-military-spouse',
    title: 'Nonresident military spouse claiming exemption (Form A4-MS)',
    covers:
      "One of the four federal-law exemptions the booklet names (Public Law 111-97). The engine " +
      'never adjudicates eligibility — it applies certificate.exempt and records WHY via exemptReason.',
    input: {
      checkDate: '2026-02-01',
      payFrequency: 'biweekly',
      earnings: { regular: 2400 },
      federalW4: { filingStatus: 'married_joint' },
      residency: { residenceState: 'TX' },
      a4: {
        exempt: true,
        exemptReason: 'Military Spouses Residency Relief Act (P.L. 111-97), Form A4-MS on file',
      },
    },
  },
  {
    id: 'overtime-2026',
    title: 'Hourly worker with $180 of overtime pay, 2026 check date',
    covers:
      "Confirms the EXPIRED overtime exclusion (Act 2023-421, ended 2025-06-30) stays expired for " +
      'every 2026 cheque: overtime is ordinary taxable wages here, with a warning noting the ' +
      'exclusion existed once, in case a caller is reconciling against a 2024/2025 figure.',
    input: {
      checkDate: '2026-03-13',
      payFrequency: 'weekly',
      earnings: { regular: 640, overtime: 180 },
      a4: { exemptionCode: 'S' },
      federalW4: { filingStatus: 'single' },
    },
  },
  {
    id: 'high-earner-dependent-tiers',
    title: 'Salaried at $145,000/yr, 3 dependents — top dependent-allowance tier',
    covers:
      "The dependent allowance's own step function, keyed to GROSS INCOME rather than filing status: " +
      'at this income each dependent is worth only $300, not the $1,000 a lower-income filer would get.',
    input: {
      checkDate: '2026-05-01',
      payFrequency: 'monthly',
      earnings: { regular: 12083.33 },
      a4: { exemptionCode: 'M', dependents: 3 },
      federalW4: { filingStatus: 'married_joint' },
    },
  },
  {
    id: 'full-employer-picture',
    title: 'Complete cheque: 401(k), Section 125, employer SUTA rate, YTD figures',
    covers:
      'Every generic mechanism this engine already had, exercised together on one Alabama cheque: ' +
      'pre-tax deductions narrowing the AL base, an employer-supplied unemployment rate replacing the ' +
      'published new-employer default, and YTD figures capping the Social Security and FUTA lines.',
    input: {
      checkDate: '2026-06-15',
      payFrequency: 'biweekly',
      earnings: { regular: 3200 },
      deductions: [
        { code: '401K', category: 'deferral_401k', amount: 200 },
        { code: 'MEDICAL', category: 'section125', amount: 90 },
        { code: 'UNION', category: 'posttax', amount: 12 },
      ],
      a4: { exemptionCode: 'M', dependents: 1 },
      federalW4: { filingStatus: 'married_joint', dependentCredit: 2200 },
      workCity: 'Gadsden',
      employer: { name: 'Delta Fabrication LLC', unemploymentRate: 0.014 },
      ytd: { socialSecurity: 42000, medicare: 42000, futa: 7000, alabamaUnemployment: 7200 },
    },
  },
];

export function alabamaScenario(id: string): AlabamaScenario {
  const found = ALABAMA_SCENARIOS.find((s) => s.id === id);
  if (!found) {
    throw new Error(
      `No Alabama scenario "${id}". Known ids: ${ALABAMA_SCENARIOS.map((s) => s.id).join(', ')}`,
    );
  }
  return found;
}
