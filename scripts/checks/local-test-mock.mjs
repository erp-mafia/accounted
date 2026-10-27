#!/usr/bin/env node
/**
 * Guard: a test that hand-rolls a helper tests/ already shares.
 *
 * The 2026-10 cleanup found 64 copies of one per-table Supabase mock
 * (`makeFlexibleSupabase`) across the v1 route tests, in 35 versions that had
 * drifted apart: some recorded calls, some normalised `count`, one answered
 * every RPC from a single key. Next to them sat 12 copies of `cronRequest()`
 * and 10 copies of the pg tests' `setActiveCompany()`. A fix to one copy never
 * reached the others, and each new test copied whichever file was nearest.
 *
 * Checks, over test files (`__tests__/`, `*.test.ts(x)`, and `tests/`):
 *   - local-supabase-chain: a thenable Proxy chain (`prop === 'then'`), the
 *     core of every hand-rolled Supabase mock. Use createTableMockSupabase,
 *     createQueuedMockSupabase or createMockSupabase from tests/helpers.ts,
 *     and extend them when a test needs something they lack. Allowlisted
 *     file-set (LOCAL_SUPABASE_CHAIN_ALLOWED), may only shrink.
 *   - local-cron-request: a local `cronRequest` helper. Use createCronRequest
 *     from tests/helpers.ts. No allowlist: 0 today.
 *   - local-set-active-company: a local `setActiveCompany`. Use the one in
 *     tests/pg/fixtures.ts. No allowlist: 0 today.
 *
 * The sanctioned homes (tests/helpers.ts, tests/pg/fixtures.ts) are exempt.
 */

import fs from 'node:fs'
import path from 'node:path'

const SCAN_DIRS = ['src', 'tests']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage'])
const EXTS = new Set(['.ts', '.tsx'])
const SANCTIONED = new Set(['tests/helpers.ts', 'tests/pg/fixtures.ts'])

const THENABLE_CHAIN_RE = /prop\s*===\s*['"]then['"]/
const CRON_REQUEST_RE = /\b(?:function\s+cronRequest\b|(?:const|let)\s+cronRequest\s*=)/
const SET_ACTIVE_COMPANY_RE = /\b(?:function\s+setActiveCompany\b|(?:const|let)\s+setActiveCompany\s*=)/

const isTestFile = (rel) =>
  rel.startsWith('tests/') ||
  rel.includes('/__tests__/') ||
  rel.endsWith('.test.ts') ||
  rel.endsWith('.test.tsx')

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out)
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

/** { supabaseChain, cronRequest, setActiveCompany }: repo-relative files per check. */
export function findLocalTestMocks(root) {
  const found = { supabaseChain: [], cronRequest: [], setActiveCompany: [] }
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir), [])) {
      const rel = path.relative(root, file).split(path.sep).join('/')
      if (!isTestFile(rel) || SANCTIONED.has(rel)) continue
      const src = fs.readFileSync(file, 'utf8')
      if (THENABLE_CHAIN_RE.test(src)) found.supabaseChain.push(rel)
      if (CRON_REQUEST_RE.test(src)) found.cronRequest.push(rel)
      if (SET_ACTIVE_COMPANY_RE.test(src)) found.setActiveCompany.push(rel)
    }
  }
  for (const list of Object.values(found)) list.sort()
  return found
}

/**
 * Test files that still build their own thenable chain. Most are mocks with a
 * real difference from the shared ones (per-call sequencing, projection
 * emulation, recorded payload shapes); each one goes when it is next touched.
 */
export const LOCAL_SUPABASE_CHAIN_ALLOWED = new Set([
  'src/app/(auth)/auth/callback/__tests__/bankid-pending.test.ts',
  'src/app/api/billing/__tests__/status.test.ts',
  'src/app/api/customers/__tests__/country.test.ts',
  'src/app/api/customers/__tests__/customer-number.test.ts',
  'src/app/api/customers/__tests__/email-clear.test.ts',
  'src/app/api/customers/__tests__/personal-number.test.ts',
  'src/app/api/customers/__tests__/reveal-personal-number.test.ts',
  'src/app/api/customers/__tests__/vies-unavailable.test.ts',
  'src/app/api/invoices/[id]/refresh-exchange-rate/__tests__/route.test.ts',
  'src/app/api/salary/employees/[id]/__tests__/personnummer-write-guard.test.ts',
  'src/app/api/salary/employees/[id]/__tests__/route.test.ts',
  'src/app/api/salary/employees/[id]/worked-hours/__tests__/recording-supabase.ts',
  'src/app/api/settings/api-keys/[id]/__tests__/route.test.ts',
  'src/app/api/settings/api-keys/__tests__/route.test.ts',
  'src/app/api/supplier-invoices/[id]/mark-paid/__tests__/duplicate-guard-band.test.ts',
  'src/app/api/transactions/[id]/categorize/__tests__/suggestion-band-currency.test.ts',
  'src/app/api/v1/api-key/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/accounts/__tests__/account-writes.test.ts',
  'src/app/api/v1/companies/[companyId]/articles/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/cash-accounts/__tests__/cash-account-writes.test.ts',
  'src/app/api/v1/companies/[companyId]/compliance/check/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/customers/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/dimensions/__tests__/dimension-crud.test.ts',
  'src/app/api/v1/companies/[companyId]/dimensions/__tests__/dimension-rules.test.ts',
  'src/app/api/v1/companies/[companyId]/dimensions/__tests__/retag-log.test.ts',
  'src/app/api/v1/companies/[companyId]/dimensions/__tests__/retag.test.ts',
  'src/app/api/v1/companies/[companyId]/dimensions/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/dimensions/__tests__/value-id.test.ts',
  'src/app/api/v1/companies/[companyId]/documents/__tests__/document-operations.test.ts',
  'src/app/api/v1/companies/[companyId]/employees/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/expense-claims/__tests__/expense-claims.test.ts',
  'src/app/api/v1/companies/[companyId]/fiscal-periods/[id]/arsredovisning/__tests__/arsredovisning-operations.test.ts',
  'src/app/api/v1/companies/[companyId]/fiscal-periods/[id]/opening-balances/__tests__/manual-and-correct.test.ts',
  'src/app/api/v1/companies/[companyId]/fiscal-periods/[id]/opening-balances/__tests__/split-per-project.test.ts',
  'src/app/api/v1/companies/[companyId]/fiscal-periods/__tests__/fiscal-period-operations.test.ts',
  'src/app/api/v1/companies/[companyId]/imports/__tests__/import-undo.test.ts',
  'src/app/api/v1/companies/[companyId]/imports/bank/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/imports/skattekonto-file/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/inbox-items/__tests__/inbox-item-matches.test.ts',
  'src/app/api/v1/companies/[companyId]/inbox-items/__tests__/inbox-item-operations.test.ts',
  'src/app/api/v1/companies/[companyId]/invoices/[id]/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/invoices/[id]/book/__tests__/book.test.ts',
  'src/app/api/v1/companies/[companyId]/invoices/[id]/send-peppol/__tests__/peppol-invoice-ops.test.ts',
  'src/app/api/v1/companies/[companyId]/invoices/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/invoices/__tests__/vat-treatment-override.test.ts',
  'src/app/api/v1/companies/[companyId]/invoices/bulk-create/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/journal-entries/[id]/__tests__/cancel-draft.test.ts',
  'src/app/api/v1/companies/[companyId]/journal-entries/[id]/commit/__tests__/unattended-limit.test.ts',
  'src/app/api/v1/companies/[companyId]/journal-entries/__tests__/create-draft-dry-run.test.ts',
  'src/app/api/v1/companies/[companyId]/journal-entries/__tests__/journal-entry-actions.test.ts',
  'src/app/api/v1/companies/[companyId]/journal-entries/__tests__/line-dimensions.test.ts',
  'src/app/api/v1/companies/[companyId]/journal-entries/__tests__/line-vat-code.test.ts',
  'src/app/api/v1/companies/[companyId]/journal-entries/__tests__/single-side-line.test.ts',
  'src/app/api/v1/companies/[companyId]/journal-entries/__tests__/source-type.test.ts',
  'src/app/api/v1/companies/[companyId]/payment-orders/__tests__/payment-orders.test.ts',
  'src/app/api/v1/companies/[companyId]/peppol/__tests__/peppol-company-ops.test.ts',
  'src/app/api/v1/companies/[companyId]/reconciliation/accounts/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/reports/__tests__/dimension-filter.test.ts',
  'src/app/api/v1/companies/[companyId]/reports/__tests__/filing-reports.test.ts',
  'src/app/api/v1/companies/[companyId]/salary-runs/[id]/__tests__/lifecycle-operations.test.ts',
  'src/app/api/v1/companies/[companyId]/salary-runs/[id]/payment-file/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/salary-runs/[id]/payment-files/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/salary-runs/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/settings/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/skatteverket/agi/__tests__/skatteverket-helpers.test.ts',
  'src/app/api/v1/companies/[companyId]/skatteverket/vat-declarations/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/supplier-invoices/[id]/__tests__/supplier-invoice-actions.test.ts',
  'src/app/api/v1/companies/[companyId]/supplier-invoices/[id]/book/__tests__/book.test.ts',
  'src/app/api/v1/companies/[companyId]/supplier-invoices/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/supplier-payment-batches/__tests__/supplier-payment-batches.test.ts',
  'src/app/api/v1/companies/[companyId]/suppliers/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/transactions/[id]/attach-document/__tests__/document-pin.test.ts',
  'src/app/api/v1/companies/[companyId]/transactions/[id]/match-expense-payout/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/transactions/__tests__/transaction-actions.test.ts',
  'src/app/api/v1/companies/[companyId]/transactions/ingest/__tests__/route.test.ts',
  'src/app/api/v1/companies/[companyId]/vat/__tests__/vat-settlement.test.ts',
  'src/extensions/general/arcim-migration/__tests__/provider-client-oauth-state.test.ts',
  'src/extensions/general/arcim-migration/__tests__/sie-data-class9.test.ts',
  'src/extensions/general/invoice-inbox/__tests__/convert-route.test.ts',
  'src/extensions/general/mcp-server/__tests__/auto-match-period.test.ts',
  'src/extensions/general/mcp-server/__tests__/bulk-book-inbox-dimensions.test.ts',
  'src/extensions/general/mcp-server/__tests__/call-tool-bridge.test.ts',
  'src/extensions/general/mcp-server/__tests__/capability-gate.test.ts',
  'src/extensions/general/mcp-server/__tests__/company-current.test.ts',
  'src/extensions/general/mcp-server/__tests__/connect-card-widget.test.ts',
  'src/extensions/general/mcp-server/__tests__/connector-catalog-reach.test.ts',
  'src/extensions/general/mcp-server/__tests__/create-invoice-builder-parity.test.ts',
  'src/extensions/general/mcp-server/__tests__/create-supplier-invoice-from-inbox.test.ts',
  'src/extensions/general/mcp-server/__tests__/inbox-credit-note.test.ts',
  'src/extensions/general/mcp-server/__tests__/list-inbox-items.test.ts',
  'src/extensions/general/mcp-server/__tests__/list-unmatched-documents.test.ts',
  'src/extensions/general/mcp-server/__tests__/mcp-tasks.test.ts',
  'src/extensions/general/mcp-server/__tests__/opening-balance-split-tools.test.ts',
  'src/extensions/general/mcp-server/__tests__/operation-tools.test.ts',
  'src/extensions/general/mcp-server/__tests__/payee-pinning.test.ts',
  'src/extensions/general/mcp-server/__tests__/payment-order-tools.test.ts',
  'src/extensions/general/mcp-server/__tests__/payroll-staged-tools.test.ts',
  'src/extensions/general/mcp-server/__tests__/pending-operations-widget.test.ts',
  'src/extensions/general/mcp-server/__tests__/query-journal.test.ts',
  'src/extensions/general/mcp-server/__tests__/receipt-matcher.test.ts',
  'src/extensions/general/mcp-server/__tests__/sie-preflight.test.ts',
  'src/extensions/general/mcp-server/__tests__/staging-behaviour.test.ts',
  'src/extensions/general/mcp-server/__tests__/test-key-write-block.test.ts',
  'src/extensions/general/mcp-server/__tests__/unattended-write-block.test.ts',
  'src/extensions/general/mcp-server/__tests__/unicode-escape-guard.test.ts',
  'src/extensions/general/mcp-server/__tests__/unknown-args-rejected.test.ts',
  'src/extensions/general/mcp-server/__tests__/vat-review-widget.test.ts',
  'src/extensions/general/mcp-server/__tests__/viewer-role-gate.test.ts',
  'src/extensions/general/tic/__tests__/bankid-complete.test.ts',
  'src/extensions/general/tic/__tests__/bankid-pending.test.ts',
  'src/extensions/general/tic/__tests__/bankid-unlink.test.ts',
  'src/lib/agent/chat/__tests__/run-turn-empty-max-tokens.test.ts',
  'src/lib/agent/chat/__tests__/run-turn-memory.test.ts',
  'src/lib/agent/chat/__tests__/run-turn-stream-retry.test.ts',
  'src/lib/agent/chat/__tests__/run-turn-thinking.test.ts',
  'src/lib/agent/intents/__tests__/verifikation-draft.test.ts',
  'src/lib/api/v1/__tests__/actor-attribution.test.ts',
  'src/lib/api/v1/__tests__/report-query-gate-strict.test.ts',
  'src/lib/api/v1/__tests__/report-query-gate.test.ts',
  'src/lib/auth/__tests__/oauth-flows.test.ts',
  'src/lib/bokslut/__tests__/bolagsskatt-calculator.test.ts',
  'src/lib/bokslut/__tests__/k3-framework-dispositions.test.ts',
  'src/lib/bokslut/assets/__tests__/asset-delete.test.ts',
  'src/lib/bokslut/assets/__tests__/depreciation-posting.test.ts',
  'src/lib/bookkeeping/__tests__/account-backfill.test.ts',
  'src/lib/bookkeeping/__tests__/asset-depreciation-entry.test.ts',
  'src/lib/bookkeeping/__tests__/commit-bulk-booking.test.ts',
  'src/lib/bookkeeping/__tests__/commit-posting-rpc-doors.test.ts',
  'src/lib/bookkeeping/__tests__/counterparty-templates.test.ts',
  'src/lib/bookkeeping/__tests__/entry-lines.test.ts',
  'src/lib/bookkeeping/__tests__/payment-sync.test.ts',
  'src/lib/core/bookkeeping/__tests__/opening-balance-split.test.ts',
  'src/lib/dashboard/__tests__/nav-flags.test.ts',
  'src/lib/entitlements/__tests__/has-capability.test.ts',
  'src/lib/entitlements/__tests__/multi-user.test.ts',
  'src/lib/import/opening-balance/__tests__/split-per-project.test.ts',
  'src/lib/invoices/__tests__/build-invoice-write-fx.test.ts',
  'src/lib/invoices/__tests__/duplicate-payment-candidates.test.ts',
  'src/lib/invoices/__tests__/supplier-invoice-handler.test.ts',
  'src/lib/operations/__tests__/inbox-convert-booking-moment.test.ts',
  'src/lib/operations/__tests__/salary-run-structure-dry-run.test.ts',
  'src/lib/pending-operations/__tests__/commit-duplicate-guard.test.ts',
  'src/lib/pending-operations/__tests__/create-invoice-executor.test.ts',
  'src/lib/pending-operations/__tests__/create-supplier-invoice-from-inbox.test.ts',
  'src/lib/pending-operations/__tests__/customer-executor.test.ts',
  'src/lib/pending-operations/__tests__/recurring-schedule-executors.test.ts',
  'src/lib/pending-operations/__tests__/staged-fx-rates.test.ts',
  'src/lib/reconciliation/__tests__/auto-reconcile-linked-voucher.test.ts',
  'src/lib/reconciliation/__tests__/bank-reconciliation.test.ts',
  'src/lib/reconciliation/__tests__/suggestions.test.ts',
  'src/lib/reconciliation/__tests__/unattended-sweep.test.ts',
  'src/lib/reference-data/__tests__/fetchers.test.ts',
  'src/lib/reports/__tests__/systemdokumentation.test.ts',
  'src/lib/salary/__tests__/cutover-parity.test.ts',
  'src/lib/supabase/__tests__/middleware.test.ts',
  'src/lib/transactions/__tests__/categorize-core.bulk.test.ts',
  'src/lib/transactions/__tests__/categorize-core.duplicate-message.test.ts',
  'src/lib/transactions/__tests__/ingest.test.ts',
  // Landed on 2026-10-11 in other merge requests, the same day as this guard
  // and before it: they were written against a main that did not have it.
  'src/app/api/v1/companies/[companyId]/invoices/bulk-create/__tests__/single-create-parity.test.ts',
  'src/app/api/v1/companies/[companyId]/journal-entries/[id]/commit/__tests__/dry-run.test.ts',
  'src/app/api/v1/companies/[companyId]/transactions/ingest/__tests__/dry-run-agreement.test.ts',
  'src/lib/bookkeeping/__tests__/commit-method-default.test.ts',
  'src/lib/pending-operations/__tests__/staged-fx-batch.test.ts',
])
