# Source verification log

Facts that MasteryTax hard-codes, or that it patched in the vendored engine, were checked against the agencies'
own documents. On 2026-10-04 they were read through a cloud Chrome session, because this build environment's
network blocks government sites.

| Fact | Source read | Result | Where it lives |
|---|---|---|---|
| California cafeteria-plan salary reductions (health, accident, group-term life, dependent care) are **Not Subject** to UI/ETT, SDI or PIT | EDD *Taxability of Employee Benefits* DE 231EB Rev. 12 (6-17), "Cafeteria Plans" | Confirmed. The engine taxed them for SDI, so the vendored data is patched | `engine/data/states/CA-*.json` `stateDisabilityEmployee` |
| California **HSA** contributions are **Subject** to UI/ETT, SDI **and PIT**, whether or not they go through a cafeteria plan (RTC 17131.4/17131.5) | DE 231EB "Health Savings Account (HSA)"; DE 231TP Rev. 1 (6-16) "Health Savings Accounts" | **The engine was wrong in three places**: it excluded HSA from CA PIT, UI and SDI wages. All three are patched | `exemptPretax`, `suiEmployer.exemptPretax`, `stateDisabilityEmployee.exemptPretax` |
| California 401(k) salary reductions are Subject to UI/ETT and SDI, Not Subject to PIT | DE 231EB "Retirement Plans – Deferred Compensation" | Confirmed (no change) | engine default |
| California qualified transportation benefits are Not Subject to UI/ETT, SDI or PIT | DE 231EB "Qualified Transportation Reimbursements" | Confirmed (no change) | engine default |
| NY Re-employment Service Fund is **0.075%** of wages subject to contribution, reported on NYS-45 line 5 | NY DOL "Unemployment Insurance Rate Information" and "Re-employment Service Fund (RSF)" (dol.ny.gov) | Confirmed | `masterytax/data/agencies.json` levy `NY_RSF` |
| EFTPS tax type for Form 941 deposits is **94105**, with tax period months 03/06/09/12 | EFTPS *Financial Institution Handbook*, IRS tax forms table | Confirmed | `agencies.json` `US-941` |
| EFTPS tax type for Form 940 deposits is **09405**, with tax period month 12 | Same | Confirmed | `agencies.json` `US-940` |
| EFTPS tax type for Form CT-1 deposits | Same ("CT-1 … Federal Tax Deposit 10005") | **Was wrong** (11105). Corrected to **10005** | `agencies.json` `US-CT1` |

A regression test pins each corrected behaviour: `tests/test_engine.py`
`test_california_ui_ett_and_sdi` and `test_california_hsa_is_taxed_for_ui_sdi_and_pit`.

## Not yet verified from a primary source

- State withholding deposit schedules other than CA, NY and the defaults (state assigned, set per company)
- SSA EFW2 and IRS MeF layouts (not implemented)
- California ETT's 0.1% figure (CUIC 976.6) wasn't re-read in this pass
