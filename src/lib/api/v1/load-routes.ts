/**
 * Side-effect import that ensures every v1 route module's top-level
 * `registerEndpoint()` call has been executed before the OpenAPI generator
 * reads the registry.
 *
 * Why this exists: route files register themselves at module load time. The
 * OpenAPI endpoint runs in its own module which would otherwise not pull in
 * the other route files. Importing them here as side-effects populates the
 * shared `ENDPOINTS` map.
 *
 * When a new v1 route is added, append a `import '...'` line.
 */

// Phase 1 surface.
import '@/app/api/v1/health/route'
import '@/app/api/v1/companies/route'
// The calling key's own grant (any valid key, no scope).
import '@/app/api/v1/api-key/route'
// Which modules a company can use, and why not (lib/modules/capabilities.ts).
import '@/app/api/v1/companies/[companyId]/capabilities/route'
// The packages behind those modules, their status and the staged switch (lib/operations/packages.ts).
import '@/app/api/v1/companies/[companyId]/packages/route'
import '@/app/api/v1/companies/[companyId]/packages/[packageId]/enable/route'
import '@/app/api/v1/companies/[companyId]/packages/[packageId]/disable/route'

// Phase 4 PR-2 (foundation): async operations polling endpoint.
import '@/app/api/v1/operations/[id]/route'

// Pending operations: the approval door for staged writes (an attest flow
// outside Accounted approves over REST as it does over MCP).
import '@/app/api/v1/companies/[companyId]/pending-operations/route'
import '@/app/api/v1/companies/[companyId]/pending-operations/[id]/route'
import '@/app/api/v1/companies/[companyId]/pending-operations/[id]/approve/route'
import '@/app/api/v1/companies/[companyId]/pending-operations/[id]/reject/route'

// Phase 4 PR-2: journal-entries primitives + voucher-gap-explanations.
import '@/app/api/v1/companies/[companyId]/journal-entries/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/[id]/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/[id]/commit/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/[id]/reverse/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/[id]/correct/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/batch-create/route'
import '@/app/api/v1/companies/[companyId]/voucher-gap-explanations/route'

// Phase 4 PR-2: compliance-check (Accounted's defensible edge).
import '@/app/api/v1/companies/[companyId]/compliance/check/route'

// Phase 4 PR-2: fiscal-periods async ops (lock/close/year-end/opening-balances/currency-revaluation).
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/lock/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/close/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/year-end/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/opening-balances/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/currency-revaluation/route'

// Phase 4 PR-3: Documents (multipart).
import '@/app/api/v1/companies/[companyId]/documents/route'
import '@/app/api/v1/companies/[companyId]/documents/[id]/download/route'
import '@/app/api/v1/companies/[companyId]/documents/[id]/link/route'

// Phase 2 PR-A: invoice + customer reads.
import '@/app/api/v1/companies/[companyId]/invoices/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/route'
import '@/app/api/v1/companies/[companyId]/customers/route'
import '@/app/api/v1/companies/[companyId]/customers/[id]/route'
// Phase 2 PR-B-2b: invoice action verbs.
import '@/app/api/v1/companies/[companyId]/invoices/[id]/mark-sent/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/mark-paid/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/credit/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/send/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/quote-status/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/cancel/route'
import '@/app/api/v1/companies/[companyId]/invoices/bulk-create/route'
// Phase 2 PR-B-3: invoice PDF + customer bulk-create.
import '@/app/api/v1/companies/[companyId]/invoices/[id]/pdf/route'
// Underlag behind an invoice (accounted#42, lib/operations/invoice-underlag.ts).
import '@/app/api/v1/companies/[companyId]/invoices/[id]/underlag/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/underlag/[documentId]/route'
// Dröjsmålsränta per invoice: lib/operations/late-payment-interest.ts
import '@/app/api/v1/companies/[companyId]/invoices/late-payment-interest/route'
import '@/app/api/v1/companies/[companyId]/customers/bulk-create/route'
// crm#1398, crm#1299: merge duplicate customers, and undo a merge.
import '@/app/api/v1/companies/[companyId]/customers/merge/route'
import '@/app/api/v1/companies/[companyId]/customers/merges/[mergeId]/undo/route'

// API parity: fixed assets (anläggningsregister).
import '@/app/api/v1/companies/[companyId]/assets/route'
import '@/app/api/v1/companies/[companyId]/assets/[id]/route'
import '@/app/api/v1/companies/[companyId]/assets/[id]/dispose/route'

// Phase 3: transactions + reconciliation vertical.
import '@/app/api/v1/companies/[companyId]/transactions/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/route'
import '@/app/api/v1/companies/[companyId]/accounts/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/categorize/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/uncategorize/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/ignore/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/match-invoice/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/match-supplier-invoice/route'
import '@/app/api/v1/companies/[companyId]/transactions/ingest/route'
import '@/app/api/v1/companies/[companyId]/transactions/batch-categorize/route'
import '@/app/api/v1/companies/[companyId]/reconciliation/bank/run/route'
import '@/app/api/v1/companies/[companyId]/reconciliation/bank/status/route'
import '@/app/api/v1/companies/[companyId]/cash-accounts/route'

// F2: PSD2 bank-connection health (last_synced_at, consent_expires) so
// integrations can detect stale bank data instead of trusting it blindly.
import '@/app/api/v1/companies/[companyId]/bank-connections/route'
import '@/app/api/v1/companies/[companyId]/bank-connections/[connectionId]/sync/route'

// Bank reading through Open Payments (operations bank-feed.*): the banks,
// the connections, the switch progress and the signatory link. The BankID
// consent itself has no door.
import '@/app/api/v1/companies/[companyId]/bank-feed/route'
import '@/app/api/v1/companies/[companyId]/bank-feed/banks/route'
import '@/app/api/v1/companies/[companyId]/bank-feed/banks/[bic]/route'
import '@/app/api/v1/companies/[companyId]/bank-feed/switch-progress/route'
import '@/app/api/v1/companies/[companyId]/bank-feed/invites/route'

// Phase 4 PR-1: AP world: suppliers + supplier-invoices verticals.
import '@/app/api/v1/companies/[companyId]/suppliers/route'
import '@/app/api/v1/companies/[companyId]/suppliers/[id]/route'
import '@/app/api/v1/companies/[companyId]/suppliers/bulk-create/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/approve/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/mark-paid/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/credit/route'
// Självfaktura document (crm#1367).
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/self-billing-pdf/route'

// Phase 5 PR-1: Payroll registers: employees + salary-runs CRUD.
import '@/app/api/v1/companies/[companyId]/employees/route'
import '@/app/api/v1/companies/[companyId]/employees/[id]/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/route'

// Phase 5 PR-2: Payroll lifecycle verbs. The /calculate orchestration was
// extracted into lib/salary/run-calculation.ts; the AGI orchestration into
// lib/salary/agi/generate-declaration.ts. Both the internal dashboard
// routes and these v1 routes call the same helpers.
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/calculate/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/approve/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/mark-paid/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/book/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/generate-agi/route'

// Payroll gap-closure 1.1: per-employee payslip reads (list + detail + PDF).
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/employees/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/employees/[employeeId]/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/payslips/[employeeId]/pdf/route'

// Payroll gap-closure 1.2: payslip line writes (draft runs only).
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/employees/[employeeId]/lines/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/lines/[lineId]/route'

// Payroll gap-closure 1.4: absence (frånvaro) range endpoints.
import '@/app/api/v1/companies/[companyId]/employees/[id]/absence/route'

// Payroll gap-closure 2.3: cutover opening balances (single + atomic bulk).
import '@/app/api/v1/companies/[companyId]/employees/[id]/opening-balances/route'
import '@/app/api/v1/companies/[companyId]/employees/opening-balances/route'
// OB / overtime premium rules (shift_premium_rules): list/create + update/delete.
import '@/app/api/v1/companies/[companyId]/salary/premium-rules/route'
import '@/app/api/v1/companies/[companyId]/salary/premium-rules/[id]/route'

// Payroll gap-closure 3.4: vacation ledger + year close.
import '@/app/api/v1/companies/[companyId]/employees/[id]/vacation-balance/route'
import '@/app/api/v1/companies/[companyId]/salary/vacation-year-close/route'

// Payroll gap-closure 4: operator onboarding. Salary settings (customer
// provisioning), worked days (tidrapport for hourly staff and OB) and the
// salary payment file (pain.001 / Bankgirot LB) for a run.
import '@/app/api/v1/companies/[companyId]/salary/settings/route'
import '@/app/api/v1/companies/[companyId]/salary/fora-report/route'
import '@/app/api/v1/companies/[companyId]/salary/vacation-liability/reconcile/route'
import '@/app/api/v1/companies/[companyId]/employees/[id]/worked-days/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/payment-file/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/payment-files/route'

// Payroll gap-closure 5: employee benefits, recurring lines, rättelsekörning.
import '@/app/api/v1/companies/[companyId]/employees/[id]/benefits/route'
import '@/app/api/v1/companies/[companyId]/employees/[id]/benefits/[benefitId]/route'
import '@/app/api/v1/companies/[companyId]/employees/[id]/recurring-lines/route'
import '@/app/api/v1/companies/[companyId]/employees/[id]/recurring-lines/[lineId]/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/correct/route'

// Phase 5 PR-3: Reports + import async. All reports wrap existing
// lib/reports/* generators. Imports run inline today but record their
// progress on the `operations` table for consistent polling-shape. KPI,
// audit-trail, periodisk-sammanstallning, ne-bilaga and ink2 followed in the
// operation registry's wave 3 (see its import block).
import '@/app/api/v1/companies/[companyId]/reports/trial-balance/route'
// Defined measures (lib/measures, operations measures.*): figures equal to their report, explained.
import '@/app/api/v1/companies/[companyId]/measures/route'
import '@/app/api/v1/companies/[companyId]/measures/[measureId]/route'
import '@/app/api/v1/companies/[companyId]/measures/[measureId]/explain/route'
// The unexplained queue (lib/unexplained, operations unexplained.*): expected-zero checks, explained.
import '@/app/api/v1/companies/[companyId]/unexplained/route'
import '@/app/api/v1/companies/[companyId]/unexplained/[checkId]/route'
import '@/app/api/v1/companies/[companyId]/unexplained/[checkId]/explain/route'
import '@/app/api/v1/companies/[companyId]/reports/balance-sheet/route'
import '@/app/api/v1/companies/[companyId]/reports/balance-sheet/pdf/route'
import '@/app/api/v1/companies/[companyId]/reports/income-statement/route'
import '@/app/api/v1/companies/[companyId]/reports/income-statement/pdf/route'
import '@/app/api/v1/companies/[companyId]/reports/general-ledger/route'
import '@/app/api/v1/companies/[companyId]/reports/journal-register/route'
import '@/app/api/v1/companies/[companyId]/reports/vat-declaration/route'
import '@/app/api/v1/companies/[companyId]/reports/vat-declaration/filings/route'
import '@/app/api/v1/companies/[companyId]/reports/monthly-breakdown/route'
import '@/app/api/v1/companies/[companyId]/reports/ar-ledger/route'
import '@/app/api/v1/companies/[companyId]/reports/supplier-ledger/route'
import '@/app/api/v1/companies/[companyId]/reports/continuity-check/route'
import '@/app/api/v1/companies/[companyId]/reports/salary-journal/route'
import '@/app/api/v1/companies/[companyId]/reports/avgifter-basis/route'
import '@/app/api/v1/companies/[companyId]/reports/vacation-liability/route'
import '@/app/api/v1/companies/[companyId]/reports/sie-export/route'
import '@/app/api/v1/companies/[companyId]/imports/sie/route'
import '@/app/api/v1/companies/[companyId]/imports/sie/upload/route'
import '@/app/api/v1/companies/[companyId]/imports/bank/route'

// Phase 6 PR-1: webhooks substrate.
import '@/app/api/v1/companies/[companyId]/webhooks/route'
import '@/app/api/v1/companies/[companyId]/webhooks/[id]/route'
import '@/app/api/v1/companies/[companyId]/webhooks/[id]/test/route'
import '@/app/api/v1/companies/[companyId]/webhooks/[id]/deliveries/route'
import '@/app/api/v1/webhook-deliveries/[id]/retry/route'

// Phase 6 PR-3: webhook secret rotation.
import '@/app/api/v1/companies/[companyId]/webhooks/[id]/rotate-secret/route'

// Endpoint ownership handshake (ADA CASA 7.1.2).
import '@/app/api/v1/companies/[companyId]/webhooks/[id]/verify/route'

// Service accounts: a non-human principal with a human sponsor, and its keys.
import '@/app/api/v1/companies/[companyId]/service-accounts/route'
import '@/app/api/v1/companies/[companyId]/service-accounts/[id]/route'
import '@/app/api/v1/companies/[companyId]/service-accounts/[id]/revoke/route'
import '@/app/api/v1/companies/[companyId]/service-accounts/[id]/keys/route'
import '@/app/api/v1/companies/[companyId]/service-accounts/[id]/keys/[keyId]/revoke/route'

// Inbox item stamp.
import '@/app/api/v1/companies/[companyId]/inbox-items/[id]/stamp/route'

// Reconciliation, account-keyed (bank:<cash_account_id> | skattekonto): the
// account list, the bridge per account, item buckets, links and ignore flags.
import '@/app/api/v1/companies/[companyId]/reconciliation/accounts/route'
import '@/app/api/v1/companies/[companyId]/reconciliation/accounts/[accountKey]/route'
import '@/app/api/v1/companies/[companyId]/reconciliation/accounts/[accountKey]/items/route'
import '@/app/api/v1/companies/[companyId]/reconciliation/accounts/[accountKey]/links/route'
import '@/app/api/v1/companies/[companyId]/reconciliation/accounts/[accountKey]/links/[linkId]/route'
import '@/app/api/v1/companies/[companyId]/reconciliation/accounts/[accountKey]/items/[itemId]/ignore/route'
import '@/app/api/v1/companies/[companyId]/reconciliation/accounts/[accountKey]/signoff/route'
import '@/app/api/v1/companies/[companyId]/reconciliation/accounts/[accountKey]/signoff/[signoffId]/reopen/route'
import '@/app/api/v1/companies/[companyId]/reconciliation/accounts/[accountKey]/residual/route'

// Dimensions PR2: registry list + value creation (kostnadsställe/projekt).
import '@/app/api/v1/companies/[companyId]/dimensions/route'
import '@/app/api/v1/companies/[companyId]/dimensions/[id]/route'
import '@/app/api/v1/companies/[companyId]/dimensions/rules/route'
import '@/app/api/v1/companies/[companyId]/dimensions/rules/[id]/route'
import '@/app/api/v1/companies/[companyId]/dimensions/retag/route'
import '@/app/api/v1/companies/[companyId]/dimensions/retag-log/route'
// Budgets (accounted#134): versions per fiscal year, amounts, copy, spread, comparison.
import '@/app/api/v1/companies/[companyId]/budgets/route'
import '@/app/api/v1/companies/[companyId]/budgets/[id]/route'
import '@/app/api/v1/companies/[companyId]/budgets/[id]/lines/route'
import '@/app/api/v1/companies/[companyId]/budgets/[id]/copy-actuals/route'
import '@/app/api/v1/companies/[companyId]/budgets/[id]/spread/route'
import '@/app/api/v1/companies/[companyId]/budgets/[id]/import/route'
import '@/app/api/v1/companies/[companyId]/reports/budget-vs-actual/route'
// Operation registry, wave 4: Peppol, årsredovisning, IB, AP actions.
import '@/app/api/v1/companies/[companyId]/invoices/[id]/peppol/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/peppol/deliveries/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/send-peppol/route'
import '@/app/api/v1/companies/[companyId]/peppol/registration/route'
import '@/app/api/v1/companies/[companyId]/peppol/access-request/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/arsredovisning/narrative/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/arsredovisning/compliance/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/arsredovisning/versions/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/arsredovisning/versions/[versionId]/signing-request/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/arsredovisning/signatures/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/arsredovisning/signatures/[signatureId]/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/arsredovisning/pdf/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/arsredovisning/ixbrl/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/arsredovisning/ixbrl/validate/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/opening-balances/manual/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/opening-balances/correct/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/opening-balances/split-per-project/route'
import '@/app/api/v1/companies/[companyId]/imports/skattekonto-file/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/uncredit/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/bank-entered/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/items/[itemId]/route'
import '@/app/api/v1/companies/[companyId]/inbox-items/[id]/match-supplier/route'
import '@/app/api/v1/companies/[companyId]/inbox-items/[id]/match-transaction/route'
import '@/app/api/v1/companies/[companyId]/skatteverket/agi/validate-huvuduppgift/route'
import '@/app/api/v1/companies/[companyId]/skatteverket/agi/validate-individuppgift/route'
import '@/app/api/v1/companies/[companyId]/skattekonto/sync/route'
// Operation registry, wave 3: documents, transactions, rättelse, filing.
import '@/app/api/v1/companies/[companyId]/documents/[id]/route'
import '@/app/api/v1/companies/[companyId]/inbox-items/route'
import '@/app/api/v1/companies/[companyId]/inbox-items/[id]/route'
import '@/app/api/v1/companies/[companyId]/inbox-items/[id]/unmatch-transaction/route'
import '@/app/api/v1/companies/[companyId]/inbox-items/[id]/convert/route'
import '@/app/api/v1/companies/[companyId]/inbox-items/[id]/purchase-category/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/attach-document/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/detach-document/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/refresh-exchange-rate/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/link-journal-entry/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/match-batch/route'
import '@/app/api/v1/companies/[companyId]/transactions/bulk-book/route'
import '@/app/api/v1/companies/[companyId]/imports/bank/[id]/undo/route'
import '@/app/api/v1/companies/[companyId]/imports/sie/[id]/undo/route'
import '@/app/api/v1/companies/[companyId]/imports/sie/[id]/resume/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/[id]/correct-metadata/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/[id]/strike-lines/route'
import '@/app/api/v1/companies/[companyId]/accrual-schedules/[id]/replan/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/[id]/redate/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/[id]/notes/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/[id]/no-document-required/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/[id]/rattelse-log/route'
import '@/app/api/v1/companies/[companyId]/journal-entries/no-document-required/route'
import '@/app/api/v1/companies/[companyId]/reports/ink2/route'
import '@/app/api/v1/companies/[companyId]/reports/ink2/sru/route'
import '@/app/api/v1/companies/[companyId]/reports/ink3/route'
import '@/app/api/v1/companies/[companyId]/reports/ne-bilaga/route'
import '@/app/api/v1/companies/[companyId]/reports/ne-bilaga/sru/route'
import '@/app/api/v1/companies/[companyId]/reports/periodisk-sammanstallning/route'
import '@/app/api/v1/companies/[companyId]/reports/periodisk-sammanstallning/csv/route'
import '@/app/api/v1/companies/[companyId]/reports/vat-declaration/eskd/route'
import '@/app/api/v1/companies/[companyId]/reports/vat-declaration/settlement-proposal/route'
import '@/app/api/v1/companies/[companyId]/reports/kassaflodesanalys/route'
import '@/app/api/v1/companies/[companyId]/reports/behandlingshistorik/route'
import '@/app/api/v1/companies/[companyId]/reports/bokslutsbilagor/route'
import '@/app/api/v1/companies/[companyId]/reports/forenklat-arsbokslut/route'
import '@/app/api/v1/companies/[companyId]/reports/forenklat-arsbokslut/pdf/route'
import '@/app/api/v1/companies/[companyId]/reports/kpi/route'
import '@/app/api/v1/companies/[companyId]/reports/dimension-pnl/route'
import '@/app/api/v1/companies/[companyId]/reports/dimension-cross/route'
import '@/app/api/v1/companies/[companyId]/reports/dimension-cross/lines/route'
import '@/app/api/v1/companies/[companyId]/audit-trail/route'
import '@/app/api/v1/companies/[companyId]/vat/settlement/route'
import '@/app/api/v1/companies/[companyId]/pos-sales/connections/route'
import '@/app/api/v1/companies/[companyId]/pos-sales/connections/[connectionId]/disconnect/route'
import '@/app/api/v1/companies/[companyId]/pos-sales/connections/[connectionId]/settings/route'
import '@/app/api/v1/companies/[companyId]/pos-sales/venues/route'
import '@/app/api/v1/companies/[companyId]/pos-sales/days/route'
import '@/app/api/v1/companies/[companyId]/pos-sales/days/[dayId]/route'
import '@/app/api/v1/companies/[companyId]/pos-sales/days/[dayId]/book/route'
import '@/app/api/v1/companies/[companyId]/pos-sales/clearing-balance/route'
import '@/app/api/v1/companies/[companyId]/pos-sales/fetch/route'
// Liquidity forecast and its rows: lib/operations/cash-forecast.ts
import '@/app/api/v1/companies/[companyId]/cash-forecast/route'
import '@/app/api/v1/companies/[companyId]/cash-forecast-rows/route'
import '@/app/api/v1/companies/[companyId]/cash-forecast-rows/cancel/route'
// Webshop orders (Shopify, WooCommerce, Zettle): lib/operations/webshop-orders.ts
import '@/app/api/v1/companies/[companyId]/webshop-orders/route'
import '@/app/api/v1/companies/[companyId]/webshop-orders/[orderId]/route'
import '@/app/api/v1/companies/[companyId]/webshop-orders/[orderId]/book/route'
import '@/app/api/v1/companies/[companyId]/webshop-orders/book-day/route'
import '@/app/api/v1/companies/[companyId]/webshop-orders/oss-underlag/route'

// Collections (reminders and debt collection through the company's provider): lib/operations/collections.ts
// and collections-booking.ts. The handover and the escalating case actions are stage-only over REST.
import '@/app/api/v1/companies/[companyId]/collections/candidates/route'
import '@/app/api/v1/companies/[companyId]/collections/settlements/route'
import '@/app/api/v1/companies/[companyId]/collections/settlements/[settlementId]/book/route'
import '@/app/api/v1/companies/[companyId]/collections/payments/[paymentId]/book/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/collection/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/collection/actions/route'
// Operation registry, wave 2: booking, payment files, utlägg, payroll.
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/send-payslips/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/revert/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/unapprove/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/employees/[employeeId]/expense-claims/route'
import '@/app/api/v1/companies/[companyId]/supplier-payment-batches/route'
import '@/app/api/v1/companies/[companyId]/supplier-payment-batches/preview/route'
import '@/app/api/v1/companies/[companyId]/supplier-payment-batches/[id]/route'
import '@/app/api/v1/companies/[companyId]/supplier-payment-batches/[id]/cancel/route'
import '@/app/api/v1/companies/[companyId]/supplier-payment-batches/[id]/file/route'
// Bank payments (payment orders): prepare, approve, cancel, follow up; signing stays in the app.
import '@/app/api/v1/companies/[companyId]/payment-orders/route'
import '@/app/api/v1/companies/[companyId]/payment-orders/[id]/route'
import '@/app/api/v1/companies/[companyId]/payment-orders/[id]/cancel/route'
import '@/app/api/v1/companies/[companyId]/payment-orders/approve/route'
import '@/app/api/v1/companies/[companyId]/payment-orders/unapprove/route'
import '@/app/api/v1/companies/[companyId]/payment-orders/availability/route'
import '@/app/api/v1/companies/[companyId]/payment-orders/usage/route'
import '@/app/api/v1/companies/[companyId]/payment-orders/verification/route'
import '@/app/api/v1/companies/[companyId]/payment-orders/verification/start/route'
import '@/app/api/v1/companies/[companyId]/payment-orders/signing-link/route'
// Bankgiro Lookup (premium, behind OPENPAYMENTS_BANKGIRO_LOOKUP).
import '@/app/api/v1/companies/[companyId]/payments/creditor-lookup/route'
import '@/app/api/v1/companies/[companyId]/payments/giro-numbers/route'
// The payment signing link: someone without a login signs approved payments with BankID (operation payment-signing-links.create).
import '@/app/api/v1/companies/[companyId]/payments/signing-links/route'
// BankID document signing: send an archived PDF for signing, read it, chase a signer, cancel (lib/operations/signing-requests.ts).
import '@/app/api/v1/companies/[companyId]/signing-requests/route'
import '@/app/api/v1/companies/[companyId]/signing-requests/[id]/route'
import '@/app/api/v1/companies/[companyId]/signing-requests/[id]/cancel/route'
import '@/app/api/v1/companies/[companyId]/signing-requests/[id]/signers/[signerId]/remind/route'
// Bolaget: the aktiebok, share classes, roles over time, firmateckning and verkliga huvudmän (lib/operations/bolaget.ts).
import '@/app/api/v1/companies/[companyId]/share-register/route'
import '@/app/api/v1/companies/[companyId]/share-register/events/route'
import '@/app/api/v1/companies/[companyId]/share-classes/route'
import '@/app/api/v1/companies/[companyId]/share-classes/[id]/route'
import '@/app/api/v1/companies/[companyId]/company-roles/route'
import '@/app/api/v1/companies/[companyId]/company-roles/[id]/end/route'
import '@/app/api/v1/companies/[companyId]/signatory-rules/route'
import '@/app/api/v1/companies/[companyId]/beneficial-owners/route'
import '@/app/api/v1/companies/[companyId]/beneficial-owners/assessments/route'
// Bolaget capital events: dividends, KU31 status, tillskott, emissions (lib/operations/bolaget-capital.ts).
import '@/app/api/v1/companies/[companyId]/capital-events/route'
import '@/app/api/v1/companies/[companyId]/ku31/[year]/route'
import '@/app/api/v1/companies/[companyId]/dividends/route'
import '@/app/api/v1/companies/[companyId]/dividends/[id]/book/route'
import '@/app/api/v1/companies/[companyId]/dividends/[id]/pay/route'
import '@/app/api/v1/companies/[companyId]/shareholder-contributions/route'
import '@/app/api/v1/companies/[companyId]/capital-changes/route'
import '@/app/api/v1/companies/[companyId]/capital-changes/[id]/book/route'
// Bolaget owner tax: K10 underlag, owner loans, KU20 status (lib/operations/bolaget-owner-tax.ts).
import '@/app/api/v1/companies/[companyId]/k10/[year]/route'
import '@/app/api/v1/companies/[companyId]/k10/[year]/owners/[partyId]/route'
import '@/app/api/v1/companies/[companyId]/owner-loans/route'
import '@/app/api/v1/companies/[companyId]/owner-loans/[id]/route'
import '@/app/api/v1/companies/[companyId]/owner-loans/[id]/interest/route'
import '@/app/api/v1/companies/[companyId]/ku20/[year]/route'
// Bolaget meetings, decisions and minutes (lib/operations/corporate-meetings.ts).
import '@/app/api/v1/companies/[companyId]/corporate-meetings/route'
import '@/app/api/v1/companies/[companyId]/corporate-meetings/[id]/route'
import '@/app/api/v1/companies/[companyId]/corporate-meetings/[id]/decisions/route'
import '@/app/api/v1/companies/[companyId]/corporate-meetings/[id]/hold/route'
// Commitments and holdings (Bolaget): agreements, their expected payments, ställda säkerheter and
// eventualförpliktelser, the group structure (lib/operations/commitments.ts).
import '@/app/api/v1/companies/[companyId]/agreements/route'
import '@/app/api/v1/companies/[companyId]/agreements/[id]/route'
import '@/app/api/v1/companies/[companyId]/agreements/[id]/end/route'
import '@/app/api/v1/companies/[companyId]/agreement-obligations/route'
import '@/app/api/v1/companies/[companyId]/securities/route'
import '@/app/api/v1/companies/[companyId]/securities/[id]/route'
import '@/app/api/v1/companies/[companyId]/group-links/route'
import '@/app/api/v1/companies/[companyId]/group-links/[id]/route'
// The underskottsregister: prior years' tax losses per fiscal year, IL 40 kap. (lib/operations/tax-loss-carryforwards.ts).
import '@/app/api/v1/companies/[companyId]/tax-loss-carryforwards/route'
import '@/app/api/v1/companies/[companyId]/tax-loss-carryforwards/[id]/route'
// The attest policy for supplier invoices and one invoice's attest trail (lib/operations/supplier-invoice-attest.ts).
import '@/app/api/v1/companies/[companyId]/supplier-invoices/attest-policy/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/attest-substitutes/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/attest-substitutes/[id]/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/attestations/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/reject/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/book/route'
import '@/app/api/v1/companies/[companyId]/invoices/bulk-book/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/book/route'
import '@/app/api/v1/companies/[companyId]/expense-claims/route'
import '@/app/api/v1/companies/[companyId]/expense-claims/[id]/route'
import '@/app/api/v1/companies/[companyId]/expense-claims/payouts/route'
import '@/app/api/v1/companies/[companyId]/transactions/[id]/match-expense-payout/route'
// Operation registry, wave 1: setup capabilities.
import '@/app/api/v1/companies/[companyId]/cash-accounts/[id]/route'
import '@/app/api/v1/companies/[companyId]/cash-accounts/[id]/set-primary/route'
import '@/app/api/v1/companies/[companyId]/cash-accounts/payee-defaults/route'
import '@/app/api/v1/companies/[companyId]/cash-accounts/change-ledgers/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/unlock/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/close-external/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/reopen-external/route'
import '@/app/api/v1/companies/[companyId]/accounts/[number]/route'
import '@/app/api/v1/companies/[companyId]/accounts/activate/route'
import '@/app/api/v1/companies/[companyId]/accounts/deactivate/route'
import '@/app/api/v1/companies/[companyId]/settings/tax-profile/route'
import '@/app/api/v1/companies/[companyId]/settings/bookkeeping-lock/route'
import '@/app/api/v1/companies/[companyId]/settings/skattekonto-account/route'
import '@/app/api/v1/companies/[companyId]/dimensions/[id]/values/route'
// #895: value lifecycle (rename/archive/end-date + delete-unreferenced).
import '@/app/api/v1/companies/[companyId]/dimensions/[id]/values/[valueId]/route'

// #895: articles read (artikelregister) for invoice line linkage.
import '@/app/api/v1/companies/[companyId]/articles/route'

// #1348: company-settings write (PATCH, MCP-tool-identical field set).
import '@/app/api/v1/companies/[companyId]/settings/route'

// #1663: filed momsdeklaration read (SKV inlamnat/beslutat).
import '@/app/api/v1/companies/[companyId]/skatteverket/vat-declarations/route'

// Portfolio: cross-company overview for multi-company keys.
import '@/app/api/v1/portfolio/overview/route'

// crm#1367: kvittning, a customer invoice set off against a supplier invoice
// of the same counterparty, and the counterparty's open items and net.
import '@/app/api/v1/companies/[companyId]/setoffs/route'
import '@/app/api/v1/companies/[companyId]/setoffs/counterparty/route'

export {}

// K3 (accounted#111): nedskrivning, component replacement, a building's tax
// plan, the split at the transition, the deferred tax inputs, the 18.7 model
// and the transition to K3 (lib/operations/k3.ts).
import '@/app/api/v1/companies/[companyId]/assets/[id]/value-adjustments/route'
import '@/app/api/v1/companies/[companyId]/assets/[id]/components/[componentId]/replace/route'
import '@/app/api/v1/companies/[companyId]/assets/[id]/tax-plan/route'
import '@/app/api/v1/companies/[companyId]/assets/[id]/transition-split/route'
import '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/deferred-tax/route'
import '@/app/api/v1/companies/[companyId]/accounting-policies/route'
import '@/app/api/v1/companies/[companyId]/k3-transition/route'
import '@/app/api/v1/companies/[companyId]/k3-transition/commit/route'
