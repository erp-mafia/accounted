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

// Phase 4 PR-2 (foundation): async operations polling endpoint.
import '@/app/api/v1/operations/[id]/route'

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
import '@/app/api/v1/companies/[companyId]/invoices/bulk-create/route'
// Phase 2 PR-B-3: invoice PDF + customer bulk-create.
import '@/app/api/v1/companies/[companyId]/invoices/[id]/pdf/route'
import '@/app/api/v1/companies/[companyId]/customers/bulk-create/route'

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

// Phase 4 PR-1: AP world: suppliers + supplier-invoices verticals.
import '@/app/api/v1/companies/[companyId]/suppliers/route'
import '@/app/api/v1/companies/[companyId]/suppliers/[id]/route'
import '@/app/api/v1/companies/[companyId]/suppliers/bulk-create/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/approve/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/mark-paid/route'
import '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/credit/route'

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

// Payroll gap-closure 3.4: vacation ledger + year close.
import '@/app/api/v1/companies/[companyId]/employees/[id]/vacation-balance/route'
import '@/app/api/v1/companies/[companyId]/salary/vacation-year-close/route'

// Phase 5 PR-3: Reports + import async. All reports wrap existing
// lib/reports/* generators. Imports run inline today but record their
// progress on the `operations` table for consistent polling-shape. KPI,
// audit-trail, periodisk-sammanstallning, ne-bilaga, and ink2 are deferred
// to a follow-up PR (different lib-module structures).
import '@/app/api/v1/companies/[companyId]/reports/trial-balance/route'
import '@/app/api/v1/companies/[companyId]/reports/balance-sheet/route'
import '@/app/api/v1/companies/[companyId]/reports/balance-sheet/pdf/route'
import '@/app/api/v1/companies/[companyId]/reports/income-statement/route'
import '@/app/api/v1/companies/[companyId]/reports/income-statement/pdf/route'
import '@/app/api/v1/companies/[companyId]/reports/general-ledger/route'
import '@/app/api/v1/companies/[companyId]/reports/journal-register/route'
import '@/app/api/v1/companies/[companyId]/reports/vat-declaration/route'
import '@/app/api/v1/companies/[companyId]/reports/monthly-breakdown/route'
import '@/app/api/v1/companies/[companyId]/reports/ar-ledger/route'
import '@/app/api/v1/companies/[companyId]/reports/supplier-ledger/route'
import '@/app/api/v1/companies/[companyId]/reports/continuity-check/route'
import '@/app/api/v1/companies/[companyId]/reports/salary-journal/route'
import '@/app/api/v1/companies/[companyId]/reports/avgifter-basis/route'
import '@/app/api/v1/companies/[companyId]/reports/vacation-liability/route'
import '@/app/api/v1/companies/[companyId]/reports/sie-export/route'
import '@/app/api/v1/companies/[companyId]/imports/sie/route'
import '@/app/api/v1/companies/[companyId]/imports/bank/route'

// Phase 6 PR-1: webhooks substrate.
import '@/app/api/v1/companies/[companyId]/webhooks/route'
import '@/app/api/v1/companies/[companyId]/webhooks/[id]/route'
import '@/app/api/v1/companies/[companyId]/webhooks/[id]/test/route'
import '@/app/api/v1/companies/[companyId]/webhooks/[id]/deliveries/route'
import '@/app/api/v1/webhook-deliveries/[id]/retry/route'

// Phase 6 PR-3: webhook secret rotation.
import '@/app/api/v1/companies/[companyId]/webhooks/[id]/rotate-secret/route'

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
import '@/app/api/v1/companies/[companyId]/dimensions/[id]/values/route'
// #895: value lifecycle (rename/archive/end-date + delete-unreferenced).
import '@/app/api/v1/companies/[companyId]/dimensions/[id]/values/[valueId]/route'

// #895: articles read (artikelregister) for invoice line linkage.
import '@/app/api/v1/companies/[companyId]/articles/route'

// #1348: company-settings write (PATCH, MCP-tool-identical field set).
import '@/app/api/v1/companies/[companyId]/settings/route'

// #1663: filed momsdeklaration read (SKV inlamnat/beslutat).
import '@/app/api/v1/companies/[companyId]/skatteverket/vat-declarations/route'

export {}
