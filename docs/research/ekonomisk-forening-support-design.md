# Ekonomisk förening support - research and implementation design

Status: design proposal, 2026-09-15; Phase 1 (legal-form spine behind a flag) implemented on `feat/ekonomisk-forening-foundation`, see "Implementation status" at the end. This is not legal advice. Regulatory facts should be rechecked against the cited primary sources when implementation ships.

## Executive decision

Add `ekonomisk_forening` as a first-class legal form, but do not model legal form as a growing collection of AB/non-AB booleans. An economic association is:

- like an AB for juridical-person taxation, INK2, tax provision, periodiseringsfond, over-depreciation, payroll, K2/K3 and annual-report preparation;
- unlike an AB for equity, member transactions, distributions, annual-report presentation, audit requirements and governance;
- unlike an ideell förening because it is always bookkeeping-obligated, files INK2 rather than INK3, and has member/contributed capital.

The correct design is a capability/policy layer behind the exhaustive `EntityType` dispatch already introduced for `ideell_forening`. A label plus account 2083 is not sufficient.

## Primary-source requirements

1. Every economic association is bookkeeping-obligated and prepares an annual report every year. A smaller association may choose K2 when eligible; otherwise it uses K3. [BFN](https://www.bfn.se/redovisningsregler/vad-galler-for/ekonomiska-foreningar/)
2. For financial years beginning 1 January 2025 or later, every economic association must send both its annual report and auditor's report to Bolagsverket no later than seven months after year-end. [Bolagsverket](https://bolagsverket.se/forening/ekonomiskforening/arsredovisningforekonomiskforening.1405.html)
3. It must have at least one auditor. An authorised auditor is required when the association exceeds at least two of 50 employees, SEK 40m assets and SEK 80m revenue in each of the two latest years (also assessed at group level for a parent association). EFL 1:3, 8:1, 8:14-15. [EFL](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-2018672-om-ekonomiska-foreningar_sfs-2018-672/)
4. The annual general meeting is held within six months after year-end. The annual report and auditor's report must be made available for at least two weeks before it; the auditor's report is due to the board at least three weeks before it. EFL 6:9, 6:23, 8:32.
5. Member contributions are restricted equity and tax-free to the association. Repayment on exit reduces restricted equity without affecting profit; a contribution forfeited by the departing member becomes taxable income. [Skatteverket](https://www.skatteverket.se/foreningar/deklarera/deklareraatenekonomiskforening.4.7eada0316ed67d7282c9fa.html)
6. Service fees are ordinary taxable turnover. Membership fees intended to cover administration are recorded as other operating income but are tax-exempt; corresponding administration costs are non-deductible. These need explicit INK2S adjustments (4.5c and 4.3c), not merely different revenue accounts. Same Skatteverket source.
7. The association files INK2 + INK2R + INK2S, including when dormant. Broadly the corporate tax rules are the same as for AB, with association-specific rules for membership fees and cooperative distributions. Same Skatteverket source.
8. Distributions are not one AB-style dividend. EFL distinguishes `vinstutdelning` and `gottgörelse` (after-payment, rebate or similar). Value transfers require restricted-capital coverage and a prudence/solvency assessment. EFL chapters 12-14.
9. A qualifying cooperative association may deduct cooperative distribution and contribution-based distribution under IL 39:22-24, subject to limitations. The decision year and tax deduction year can differ from the payment year. [Skatteverket legal guidance](https://www4.skatteverket.se/rattsligvagledning/329580.html)
10. The association must maintain a member register containing identity, admission date, number of contributions and total paid/credited contributions from the latest adopted balance sheet. Removed records must be retained for seven years. Each member can request a membership/contribution certificate. EFL chapter 5.
11. If subordinated contributions (`förlagsinsatser`) are used, a separate register is required with amount, contribution date and distribution right; redemption has its own statutory constraints. EFL chapter 11.

## What the repository already provides

The September 2026 `ideell_forening` work created the right extension seam:

- `types/index.ts` has a closed `EntityType` union.
- `lib/company/entity-type.ts` uses exhaustive `Record<EntityType, T>` dispatch and fails closed on unknown types.
- `supabase/migrations/20260908143051_ideell_forening_entity_type.sql` centralises the database whitelist through `supported_entity_types()` and updates all live company-creation RPCs.
- Registry mapping is allow-listed in `lib/company-lookup/entity-type-map.ts` rather than inferred by substring.
- The year-end result account and prior-year carry account are already policy-driven.

This should be extended, not bypassed. The ideell implementation changed 111 files; economic-association support will have a similar cross-section plus member-capital and association-specific annual-report work.

## Current blockers and incorrect AB assumptions

### 1. Type and creation gates

`EntityType` lacks `ekonomisk_forening`; the DB constraints and `supported_entity_types()` lack it; onboarding and registry lookup cannot map it. Add a feature flag exactly as for `ideell_forening`, and map only exact registry values such as `ekonomisk förening`. Never silently coerce an unsupported registered subtype (credit-market, insurance or other specially regulated association).

### 2. Accounting framework is incorrectly documented and enforced as AB-only

`AccountingFramework = 'k2' | 'k3'` is valid for an economic association, but `types/index.ts` describes it as AB-only and `app/api/company/current/route.ts` rejects K3 for every non-AB. Replace this with a capability such as `annualReportFrameworks(entityType)`. Economic associations allow K2 or K3 subject to the same general eligibility assessment plus form/subtype restrictions.

### 3. Chart of accounts

The AB seed creates 2081/2091/2099. The economic-association seed needs, at minimum:

- 2083 `Medlemsinsatser` - restricted equity;
- 2084 `Förlagsinsatser` - restricted equity, optional but supported;
- 2086 `Reservfond` - restricted equity;
- 2091 `Balanserad vinst eller förlust`;
- 2099 `Årets resultat`;
- 2890 (or explicit member-liability subaccounts) for expenses/ordinary settlement with members;
- 2898 only where a valid, decided value transfer is payable and the account semantics fit;
- ordinary 21xx, 25xx, 75xx, 88xx and 89xx accounts needed by juridical-person closing.

Do not call a general member settlement `skuld till aktieägare` (2893). Do not confuse an insats with revenue, a member loan, a service fee, a membership fee, or a donation.

The bundled BAS catalogue already contains 2083 and 2084, but the current AB iXBRL mapper deliberately collapses them into `Reservfond` and warns. That behavior is proof that the AB annual-report taxonomy cannot be reused for an economic association.

### 4. Booking templates and categorisation

Add form-specific templates with explicit tax semantics:

- payment/receivable of obligatory contribution and over-contribution;
- credited contribution through contribution issue (`insatsemission`);
- repayment on member exit, with a hard check against the member subledger and a review gate for statutory timing/amount constraints;
- forfeited contribution → taxable income;
- member loan received/repaid, distinct from equity;
- membership fee → other operating income, tax-exempt flag;
- service fee → normal turnover and normal VAT rules;
- connection/entry fees with allocation/periodisation support;
- subordinated contribution received/redeemed;
- decided profit distribution and payment;
- decided cooperative rebate/after-payment and payment.

Templates should emit structured `tax_tags` and `association_event_type`; account number alone is insufficient to produce correct INK2S or reconstruct member balances.

### 5. Member-capital subledger (new bounded context)

Create these conceptual tables (names illustrative):

- `association_members`: company, party/person reference, admission/exit dates, member class, active state, immutable audit metadata.
- `association_member_contributions`: member, contribution kind (`obligatory`, `over`, `emission`), units, amount, due/paid/credited dates, source voucher line, status.
- `association_member_events`: admission, transfer, notice of exit, exit, expulsion, contribution adjustment; append-only.
- `association_distributions`: kind (`profit_distribution`, `cooperative_rebate`, `after_payment`, `contribution_distribution`), decision period/date, allocation basis, tax treatment, AGM/board evidence, payable voucher and payment voucher.
- `association_distribution_allocations`: distribution-to-member/other-party allocation and basis value.
- `association_subordinated_contributions`: holder, amount, date, distribution right, notice/redemption dates and source voucher.

Invariants:

- every posted capital movement links one-to-one to a posted journal line;
- no hard deletion; corrections are append-only and link to the original event/voucher;
- aggregate member contributions reconcile to 2083; subordinated contributions reconcile to 2084; decided unpaid transfers reconcile to their payable account;
- exiting a member cannot automatically book repayment without a confirmed legal decision and calculated ceiling;
- historic member/subordinated-contribution records remain exportable for at least seven years;
- permissions separate accounting, register administration and approval of value transfers.

This module is necessary for complete legal-form support. It can be deferred from a bookkeeping MVP only if the UI explicitly says that Accounted does not maintain the statutory member register and all capital/distribution templates require an external register reference.

### 6. Year-end closing and corporate tax

`lib/bokslut/dispositions-proposal-builder.ts`, `overavskrivningar-calculator.ts` and the UI currently gate juridical-person dispositions on `entityType === 'aktiebolag'`. This would omit legitimate and necessary closing items for an economic association.

Introduce capabilities instead:

```ts
usesInk2(entityType)
booksCurrentTax(entityType)
supportsPeriodiseringsfond(entityType)
supportsOverdepreciation(entityType)
preparesAnnualReport(entityType)
requiresAuditor(entityType)
supportsMemberCapital(entityType)
```

For `ekonomisk_forening`, the first six are true. `usesOwnerDrawings` is false. SLP depends on pension cost/employer facts, not legal form.

Close the year to 2099 and carry the previous year's result to 2098, then post the AGM's actual disposition separately. The disposition model must support retained result, ordinary profit distribution, cooperative distribution/gottgörelse, allocation to/from restricted funds where legally permitted, and non-cash decisions. Do not reuse `proposed_dividend` as the domain model.

### 7. INK2/INK2R/INK2S

`lib/reports/ink2/ink2-engine.ts` rejects non-AB at runtime even though Skatteverket requires INK2 for economic associations. Replace the gate with `usesInk2` and add association-specific tax adjustments:

- tax-exempt membership fees → INK2S 4.5c;
- matching non-deductible administration cost → 4.3c, with user-confirmed allocation rather than assuming equality;
- cooperative distribution deductions and limits under IL 39;
- forfeited member contribution as taxable income;
- correct tracking of decision year versus payment year;
- ordinary corporate tax, loss carry-forward, periodiseringsfond, over-depreciation and other INK2 logic.

The INK2R account mapping can largely be shared: SRU field 7301 holds restricted equity and 7302 unrestricted equity. Preserve account-level audit detail even though the filed fields aggregate it.

### 8. Annual report and filing package

`evaluateAnnualReportEligibility()` currently hard-blocks every non-AB. `preparesArsredovisning()` returns false for all existing associations. The PDF/data model is AB-shaped: `aktiekapital`, share premium, `kontrollbalans_required`, `proposed_dividend`, AB equity rows and an AB-specific iXBRL taxonomy.

Build a form-neutral annual-report core with form-specific policies/renderers:

- common: company/period, management report, multi-year overview, income statement, most balance-sheet posts, notes, signatures and versioning;
- AB adapter: share capital, AB distributions, capital-deficiency disclosures and AB filing taxonomy;
- economic-association adapter: member contributions, subordinated contributions, reserve fund, movement in each equity component, member-count/member-capital disclosures required by applicable K2/K3/ÅRL rules, association distribution proposal, and no AB `kontrollbalansräkning` assertion;
- signature/roles: all board members and CEO if appointed; auditor's report remains a separate required attachment;
- workflow dates: report signed → auditor report received → AGM adopted statements and actual result disposition → copies/certificates assembled → Bolagsverket submission.

Keep AB and association statement mappings distinct. The current AB mapper maps 2083/2084 into `Reservfond`; that is materially wrong presentation for an economic association. Do not emit economic-association iXBRL using the bundled `k2-ab` taxonomy. Initially produce a validated paper/PDF filing package if that is the currently accepted channel; add digital filing only against a Bolagsverket taxonomy and API that explicitly supports economic associations at implementation time.

### 9. Deadlines and worklist

Current deadlines gate INK2, annual report and AGM on AB. For an economic association add:

- INK2 using the juridical-person fiscal-year schedule;
- auditor's report to board: three weeks before AGM (event-relative, not simply FY-relative);
- documents available to members: two weeks before AGM;
- AGM: six months after FY end;
- annual report + auditor's report to Bolagsverket: seven months after FY end;
- escalation before eleven months because non-filing can trigger compulsory liquidation.

Descriptions must say `ekonomisk förening`, not AB. The due-date generator should be policy-driven so legal forms share calculation but not labels or prerequisites.

### 10. Audit workflow

Unlike a small private AB, every economic association has an auditor and an auditor's report every year. Store:

- auditor identity, term, qualification and appointment evidence;
- whether authorised qualification is required from two-year entity/group metrics;
- auditor-report document, signed/completed date, opinion status and deviations;
- a hard filing-package blocker if the auditor's report is absent;
- a reconciliation/export bundle for audit, including member and subordinated-contribution registers.

Accounted need not author the auditor's opinion. It must manage the dependency and attach/archive the externally signed report.

### 11. Migration of a misclassified existing company

Never update only `companies.entity_type`. Provide a guarded migration preview and transaction:

1. Verify the registry legal form and target `ekonomisk_forening`.
2. Inspect open/locked years, filings, posted equity/member/shareholder transactions, active integrations and annual-report versions.
3. Re-seed/add missing association accounts without deleting user accounts.
4. Propose account remaps, never execute ambiguous ones automatically: 2081→2083 may be plausible; 2893 can be a member loan, expense payable or bad historic owner classification and requires review.
5. Recompute report/deadline capabilities and invalidate only draft derived artefacts; retain all audit history.
6. Reconcile opening/closing equity and member subledger.
7. Commit atomically with an immutable migration record and rollback plan before any new posting.

For Growhub, the earlier inspection found no opening balances or journal entries. That makes it the safest migration class: change legal form, replace the empty chart seed, configure member contribution opening state, then validate before the first posting.

## Recommended delivery phases

### Phase 0 - specification fixtures

- Obtain anonymised statutes, one K2 and one K3 economic-association annual report, INK2 examples, member/contribution scenarios and auditor feedback.
- Create a compliance matrix: rule → source → code owner → test.
- Decide MVP boundary for the statutory member register.

Exit: a Swedish accountant/auditor who works with economic associations signs off the fixtures and account treatments.

### Phase 1 - safe legal-form spine (behind flag)

- Add type, DB constraints, central supported list, all creation RPCs, exact registry mapping and onboarding label.
- Extend exhaustive entity policies; replace every material AB equality gate with a named capability.
- Seed association chart and add form-specific templates.
- Keep creation disabled in production until Phase 2 acceptance passes.

Exit: compiler exhaustiveness, DB tests, create/onboard tests, chart snapshot, no AB/EF owner accounts, ordinary invoices/VAT/payroll/SIE round trips pass.

### Phase 2 - correct bookkeeping, closing and INK2

- Implement member-capital MVP/subledger, tax tags and reconciliation reports.
- Enable corporate dispositions/tax for the form.
- Enable INK2 with association adjustments.
- Add deadlines/worklist.

Exit: golden-ledger scenarios reconcile to trial balance, INK2R/S and expected tax; correction/reversal and SIE import/export preserve traceability.

### Phase 3 - K2 annual report and audit package

- Refactor annual-report common core plus economic-association adapter.
- Add association equity statement/notes, distribution proposal, signatures, adoption and mandatory auditor-report attachment.
- Generate the currently valid filing package; no AB taxonomy reuse.

Exit: complete K2 sample accepted by a domain reviewer and passes internal completeness, arithmetic, cross-document and filing-package validators.

### Phase 4 - K3, advanced capital and distributions

- K3 disclosures/cash flow/deferred tax for the form.
- Full contribution issues, subordinated contributions, transfers, redemption constraints, cooperative distribution/gottgörelse and group/parent-association cases.
- Digital filing only when supported by authoritative schema/API.

Exit: advanced fixtures and external domain review pass.

### Phase 5 - migrate and release

- Run migration preview for misclassified companies.
- Pilot with Growhub and at least one association with real historic transactions.
- Monitor warnings, reconciliation failures and manual overrides; only then remove the feature flag.

## Minimum acceptance suite

1. Create an economic association from exact registry lookup; unsupported special subtype fails closed.
2. Seed contains 2083/2084/2086/2091/2099 and not 2081/2893/2013/2018.
3. Ordinary sale, purchase, VAT, salary and bank matching behave exactly as for other juridical persons.
4. Paid contribution: Dr bank / Cr 2083, tax result unchanged, member ledger reconciles.
5. Valid exit repayment: Dr 2083 / Cr bank or payable, profit unchanged; overpayment is blocked.
6. Forfeited contribution is posted to taxable income and reaches INK2 tax calculation.
7. Membership fee and allocated administration cost produce 4.5c/4.3c adjustments with audit evidence.
8. Service fee reaches net turnover and follows configured VAT treatment.
9. Member loan never changes 2083 and never uses shareholder wording.
10. Periodiseringsfond, over-depreciation, SLP and 20.6% current-tax scenarios match expected entries and INK2.
11. Year-end closes to 2099, next year carries to 2098, AGM disposition posts separately and idempotently.
12. K2 balance sheet shows member contributions and subordinated contributions as their own restricted-equity posts, not reserve fund or share capital.
13. Annual-report package cannot reach fileable status without all board/CEO signatures (as applicable), AGM decision and auditor's report.
14. Deadlines compute correctly for calendar and broken fiscal years.
15. SIE import/export round-trip retains account balances; member-subledger gaps are surfaced as blocking reconciliation issues, never silently fabricated.
16. Migration preview on an empty misclassified company is deterministic; migration with posted 2081/2893 activity requires explicit mapping decisions.

## Architectural recommendation

Keep `EntityType` exhaustive, but make policies semantic rather than using `byEntityType` at every call site. A compact `LegalFormPolicy` should expose accounting, tax, reporting, governance and equity capabilities. This avoids the next form multiplying literal comparisons across another 100+ files, while retaining compile-time exhaustiveness at the policy construction boundary.

The critical release rule is simple: the feature is not “supported” when onboarding accepts the label. It is supported only when the same legal form flows consistently through account seeding, booking templates, member capital, year-end, INK2, annual report, auditor dependency, deadlines, migration and exports.

## Implementation status (2026-09-15, foundation PR)

Shipped, behind `NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED`:

- `ekonomisk_forening` in `EntityType`, `ENTITY_TYPES`, the registry mapping (exact spellings only) and the onboarding picker; DB CHECK constraints, `supported_entity_types()` and the chart seed (2083, 2084, 2086, 2091, 2099, 2890, personnel accounts) in migration `20260915150000`, covered by `ekonomisk-forening-foundation.pg.test.ts`.
- Capabilities in `lib/company/entity-type.ts`: `usesInk2`, `booksCurrentTax`, `supportsCorporateTaxDispositions`, `requiresAuditorRegardlessOfSize`, `supportsMemberCapital`, `supportsAccountingFramework`, `preparesArsredovisning`.
- Sites moved from `=== 'aktiebolag'` to a capability: dispositions proposal, överavskrivningar, INK2 engine, statement reconciliation, historical result repair, K2/K3 route and settings, skattekonto rule scoping, Peppol supplier gate, agent atom fallback, INK2 navigation and report catalog.
- Deadlines: `inkomstdeklaration_ekonomisk_forening`, `arsredovisning_ekonomisk_forening`, `foreningsstamma`.
- Booking templates: payroll, pension and placement templates apply to both juridiska personer; new `member_contribution_received` (2083), `debenture_contribution_received` (2084) and `membership_fee_received` (3901, INK2S 4.5c/4.3c note).

Also shipped on the same branch (second iteration):

- INK2S (section 7): membership fees on the seeded 3901 account are detected as a 4.5c deduction (`detectedTaxAdjustmentAccounts`), and the INK2 engine warns until the 4.3c administration cost has been entered manually.
- K2 annual report (section 8): the K2 mapper has a legal-form option (2083 Medlemsinsatser, 2084 Förlagsinsatser as own posts; share capital flagged), the balance sheet, the equity-change table, the resultatdisposition table and the fastställelseintyg use association wording, förvaltningsberättelsen carries the four ÅRL 6 kap. 3 § member disclosures (new narrative columns, migration `20260915150100`), the revisionsberättelse is mandatory (EFL 8 kap. 1 §) and the ÅRL 6 kap. 3 § member statement blocks filing. iXBRL preview and direct filing stay disabled for the form; K3 fails closed.
- Misclassified company (section 11, empty-books class): `correct_company_entity_type()` (migration `20260915150200`, owner-only, re-seeds the chart, audit-logged) exposed through `PATCH /api/company/current { entity_type }`.

Deliberately not in this branch (fails closed or manual):

- Member register, insatsemission, exit repayment ceiling, förlagsinsats redemption, cooperative distributions and gottgörelse (sections 5 and 4): manual bookkeeping against an external register until the member-capital module ships; the templates say so.
- K3 annual report for the form (the K3 equity statement is AB-shaped), digital filing (no Bolagsverket taxonomy for ekonomiska föreningar in the bundle).
- Audit workflow beyond the mandatory revisionsberättelse dependency (section 10), and migration of a company with posted history (section 11).
