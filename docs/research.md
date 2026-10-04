# Research: ADP MasterTax

## What it is

**MasterTax** is payroll-tax filing software. ADP bought it in 2010 and runs it as a separate company
(Franklin, Wisconsin). Its customers are **payroll service providers, PEOs and mid-to-large employers** that run
their own payroll but want one system to handle tax liabilities, deposits and filings across jurisdictions.
ADP also sells **SmartCompliance**, a managed service in which ADP files for you. MasterTax is the
"you stay in control" product.

## What it does (from MasterTax's published feature list)

| Area | MasterTax capability |
|---|---|
| Import | Import payroll data from any payroll system. An *auditable process report* flags issues and holds items in a queue until they are resolved. |
| Rates & jurisdictions | Built-in compliance for **11,000+ jurisdictions**, plus a Tax Locator tool for local tax codes and rates. |
| Deposits | Schedules payroll tax payments and tracks variances. Handles e-file, EFTPS and EFT instructions. |
| Returns | Federal 940/941, state withholding and SUI, local returns, W-2/W-2c, ACA. |
| Amendments | W-2c, 941-X, ACA and state amendments. Adjustments update liabilities automatically. |
| Integration | APIs and implementation services. |
| Claimed outcome | "Up to 70%" less time spent processing payroll taxes. |

## What users complain about

- **Availability.** A G2 reviewer reported days when the service was down, which blocked their daily tasks.
- **Lock-in and migration pain.** Payroll.org community threads describe moving between MasterTax and ADP
  SmartCompliance as painful. There is no automated mapping between the two, and the "loss of control" after the move was the
  biggest complaint.
- **Opacity.** The rate tables and calculation logic are proprietary. When a number looks wrong, you can't see the
  rule that produced it. You open a support ticket.
- **Enterprise-only.** Pricing is sales-led. Small bureaus and in-house teams can't try it, script it or
  run it locally.
- **Few public reviews.** G2 doesn't have enough reviews to give buying insight, which is typical of a niche
  enterprise tool.

## What "better" means for MasteryTax

MasteryTax computes taxes with the `payroll-tax-engine` (vendored in `engine/`). That engine covers
federal, all 50 states + DC and the major local systems (Pennsylvania EIT/LST, Ohio municipal, school district
and JEDD, Michigan cities, Kentucky occupational, Alabama, Indiana counties, NYC/Yonkers, Portland, Seattle)
for 2025 and 2026, and every value carries its source. On top of that, MasteryTax attacks the structural
weaknesses above:

1. **Every number explains itself.** Each liability carries a trace: rate, taxable wages, wage-base position,
   the rule version and its source.
2. **Rules are data.** Rates and wage bases live in effective-dated JSON with sources and are reviewable in a pull request.
   Anyone can diff a rate change.
3. **It checks payroll instead of trusting it.** Statutory taxes are recomputed. Income-tax withholding is
   re-derived from each employee's W-4 and state certificates. Every variance is flagged before filing (for
   example, forgotten Additional Medicare tax, an ignored W-4 extra withholding, or Social Security withheld
   past the annual maximum).
4. **Penalty exposure up front.** Deposits are matched to obligations, and the failure-to-deposit penalty
   (IRC §6656 tiers) is estimated before the IRS sends a notice.
5. **Amendments by recomputation.** 941-X and W-2c are produced by diffing the original and corrected payroll,
   including wage-base side effects that hand-keyed adjustments miss.
6. **Tax locator.** Work and home addresses resolve to the local-tax codes the engine needs (PA PSD, Ohio
   city and school district, JEDDs, NYC/Yonkers, transit districts), using Census and agency boundary data.
7. **No lock-in, no outage dependency.** Plain CSV/JSON in and out, runs offline, open source, scriptable
   CLI, JSON output, and a self-contained HTML report.

## Sources

- [MasterTax product features](https://www.mastertax.com/product/features)
- [MasterTax home](https://www.mastertax.com/) · [About](https://www.mastertax.com/about-us) ·
  [For payroll service providers](https://www.mastertax.com/why-mastertax/payroll-service-providers) ·
  [APIs & integration](https://www.mastertax.com/product/implementation-api-integration)
- [G2 reviews](https://www.g2.com/products/mastertax/reviews)
- [Payroll.org community: ADP SmartCompliance vs MasterTax](https://community.payroll.org/discussion/adp-smart-compliance-versus-mastertax)
- [Payroll.org community: MasterTax vs ADP Employment Tax](https://community.payroll.org/discussion/master-tax-vs-adp-employment-tax)
- [APA year-end solutions buyer's guide](https://payroll.org/docs/default-source/buyers-guides/23e-Year-End-Solutions-bg.pdf)
- Rate facts in `masterytax/data/rules.json` were checked against:
  [2026 SS wage base $184,500](https://payroll.org/news-resources/news/news-detail/2025/10/24/social-security-wage-base-increases-to-$184-500-for-2026),
  [CA SDI 1.3% for 2026](https://edd.ca.gov/en/payroll_taxes/rates_and_withholding),
  [NY UI wage base $17,600 for 2026](https://news.bloombergtax.com/payroll/new-york-unemployment-wage-base-rising-to-17-600-for-2026),
  [2025 FUTA credit reductions (CA 1.2%, VI 4.5%)](https://www.federalregister.gov/documents/2026/01/12/2026-00342/notice-of-the-federal-unemployment-tax-act-futa-credit-reductions-applicable-for-2025)
