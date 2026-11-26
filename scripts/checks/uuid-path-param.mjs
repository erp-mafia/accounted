#!/usr/bin/env node
/**
 * Guard: a session route whose path names a row by id, with no uuid check.
 *
 * A dynamic segment reaches the handler as whatever the URL carried. Opened by
 * hand as /bookkeeping/new, the verifikat page asked its routes about `new`;
 * every route that put the segment into a filter on a uuid column got a
 * refusal from Postgres (22P02, invalid input syntax for type uuid), and
 * dozens of session routes answered that refusal as a 500 (2026-11). The
 * `uuidParams` option of withRouteContext (lib/api/uuid-params.ts) answers
 * the route's own 404 for a value that is not a uuid before the handler runs;
 * v1 has the same rule in its wrapper (malformedPathIds) and needs nothing
 * here.
 *
 * Flagged: an app/api route.ts outside v1 that uses withRouteContext, has a
 * path segment named `[id]` or ending in Id (`[employeeId]`), and checks no
 * uuid: no `uuidParams`, no isUuid / UUID_RE, no zod uuid schema. A segment
 * that is not a uuid (a year, an account number, a token) has another name;
 * one named like an id that holds something else belongs in NOT_A_UUID with
 * its reason.
 *
 * Also flagged, with no baseline: a `uuidParams` name that is none of the
 * route's path segments. The wrapper counts a declared parameter the request
 * lacks as no uuid, so such a name answers every request 404.
 *
 * UUID_PATH_PARAM_ALLOWED holds the routes that predate the guard. Three are
 * known to answer 500 to a malformed id and are marked. The rest did not
 * answer 500 when called with one (most answer 404 for any error), but the
 * writes among them were called with an empty body only, which their body
 * check refuses first. It may only shrink: give a route the option when it is
 * touched.
 */

import fs from 'node:fs'
import path from 'node:path'

export const UUID_PATH_PARAM_HINT =
  "  → declare the segment on the wrapper: withRouteContext(op, handler, { uuidParams: { id: 'X_NOT_FOUND' } }),\n" +
  '    with the code the route answers for a row that is not there (NOT_FOUND when it has none of its own).\n' +
  '    A segment named like an id that is not a uuid goes in NOT_A_UUID in scripts/checks/uuid-path-param.mjs.'

/** { route file: why its id-named segment is not a uuid }. */
export const NOT_A_UUID = {}

const ID_SEGMENT_RE = /\[(?:\.\.\.)?(id|[A-Za-z]+Id)\]/
const CHECKED_RE = /\buuidParams\b|\bisUuid\(|\bUUID_RE\b|\.uuid\(\)|\bz\.uuid\(/

/**
 * Whether one route file is flagged: `rel` is its path relative to src,
 * `source` its text.
 */
export function isUndeclaredUuidPathParam(rel, source) {
  if (!rel.startsWith('app/api/') || rel.startsWith('app/api/v1/')) return false
  if (!rel.endsWith('/route.ts') || !ID_SEGMENT_RE.test(rel)) return false
  if (!/\bwithRouteContext\b/.test(source)) return false
  if (Object.hasOwn(NOT_A_UUID, rel)) return false
  return !CHECKED_RE.test(source)
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') walk(full, out)
    } else if (entry.name === 'route.ts') {
      out.push(full)
    }
  }
  return out
}

function routeFiles(sourceRoot) {
  const apiDir = path.join(sourceRoot, 'app', 'api')
  if (!fs.existsSync(apiDir)) return []
  return walk(apiDir).map((file) => ({ file, rel: path.relative(sourceRoot, file).split(path.sep).join('/') }))
}

/** Every flagged route under sourceRoot, relative to it, sorted. */
export function findUndeclaredUuidPathParams(sourceRoot) {
  return routeFiles(sourceRoot)
    .filter(({ file, rel }) => isUndeclaredUuidPathParam(rel, fs.readFileSync(file, 'utf8')))
    .map(({ rel }) => rel)
    .sort()
}

/**
 * The names a route file declares in `uuidParams` that are none of its path
 * segments. A declared parameter the request does not carry counts as no
 * uuid, so a misspelt name answers every request 404. The option's type
 * catches it only where the route types its params.
 */
export function misdeclaredUuidParamsInSource(rel, source) {
  const segments = new Set([...rel.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map((m) => m[1]))
  const names = [...source.matchAll(/\buuidParams:\s*\{([^}]*)\}/g)].flatMap((m) =>
    [...m[1].matchAll(/(\w+)\s*:/g)].map((k) => k[1]),
  )
  return [...new Set(names)].filter((name) => !segments.has(name))
}

/** Every route under sourceRoot that declares a name its path lacks: [{ file, names }], sorted. */
export function findMisdeclaredUuidParams(sourceRoot) {
  return routeFiles(sourceRoot)
    .map(({ file, rel }) => ({ file: rel, names: misdeclaredUuidParamsInSource(rel, fs.readFileSync(file, 'utf8')) }))
    .filter((f) => f.names.length > 0)
    .sort((a, b) => a.file.localeCompare(b.file))
}

/** @type {Set<string>} */
export const UUID_PATH_PARAM_ALLOWED = new Set([
  'app/api/agent/conversations/[id]/reject-pending/route.ts',
  'app/api/agent/conversations/[id]/route.ts',
  'app/api/agent/memory/[id]/route.ts',
  'app/api/arkiv/agreements/[id]/route.ts',
  'app/api/arkiv/documents/[id]/route.ts',
  'app/api/arkiv/facts/[id]/revert/route.ts',
  'app/api/arkiv/findings/[id]/route.ts',
  'app/api/assets/[id]/components/[componentId]/replace/route.ts',
  'app/api/assets/[id]/components/route.ts',
  'app/api/assets/[id]/dispose/route.ts',
  'app/api/assets/[id]/identification/route.ts',
  'app/api/assets/[id]/tax-plan/route.ts',
  'app/api/assets/[id]/transition-split/route.ts',
  'app/api/assets/[id]/value-adjustments/route.ts',
  'app/api/bank/open-payments/connections/[id]/poll/route.ts',
  'app/api/bank/open-payments/connections/[id]/restart/route.ts',
  'app/api/bank/open-payments/connections/[id]/route.ts',
  'app/api/bank/open-payments/connections/[id]/select/route.ts',
  'app/api/bank/open-payments/connections/[id]/sync/route.ts',
  'app/api/bolaget/aktiebrev/[eventId]/route.ts',
  'app/api/bolaget/holders/[partyId]/extract/route.ts',
  'app/api/bolaget/meetings/[id]/bankid/route.ts',
  'app/api/bolaget/meetings/[id]/decisions/[decisionId]/route.ts',
  'app/api/bolaget/meetings/[id]/decisions/route.ts',
  'app/api/bolaget/meetings/[id]/hold/route.ts',
  'app/api/bolaget/meetings/[id]/pdf/route.ts',
  'app/api/bolaget/meetings/[id]/route.ts',
  'app/api/bolaget/meetings/[id]/sign/route.ts',
  'app/api/bolaget/people/[partyId]/route.ts',
  'app/api/bolaget/roles/[id]/end/route.ts',
  'app/api/bolaget/share-classes/[id]/route.ts',
  'app/api/bookkeeping/accruals/[id]/dissolve/route.ts',
  'app/api/bookkeeping/accruals/[id]/route.ts',
  'app/api/bookkeeping/contract-revenue/contracts/[id]/route.ts',
  'app/api/bookkeeping/finance-leases/[id]/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/accruals/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/arsredovisning/signatures/from-roles/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/arsredovisning/versions/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/bokslut-readiness/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/bokslutsdispositioner/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/close-external/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/ef-declaration/inputs/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/ef-declaration/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/entry-count/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/lock/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/reopen-external/route.ts',
  // Known to answer 500 to a malformed id, left out while another change edits
  // the period close and reopen routes: give them the option next.
  'app/api/bookkeeping/fiscal-periods/[id]/reopen/route.ts',
  // Known 500, as reopen above.
  'app/api/bookkeeping/fiscal-periods/[id]/reset/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/route.ts',
  'app/api/bookkeeping/fiscal-periods/[id]/unlock/route.ts',
  // Known 500, as reopen above.
  'app/api/bookkeeping/fiscal-periods/[id]/year-end/route.ts',
  'app/api/bookkeeping/inventory-counts/[id]/bankid/route.ts',
  'app/api/bookkeeping/inventory-counts/[id]/book/route.ts',
  'app/api/bookkeeping/inventory-counts/[id]/pdf/route.ts',
  'app/api/bookkeeping/inventory-counts/[id]/route.ts',
  'app/api/bookkeeping/inventory-counts/[id]/sign/route.ts',
  'app/api/bookkeeping/journal-entries/[id]/chain/route.ts',
  'app/api/bookkeeping/journal-entries/[id]/correct-metadata/route.ts',
  'app/api/bookkeeping/journal-entries/[id]/correct/route.ts',
  'app/api/bookkeeping/journal-entries/[id]/no-document-required/route.ts',
  'app/api/bookkeeping/journal-entries/[id]/notes/route.ts',
  'app/api/bookkeeping/journal-entries/[id]/recordate/route.ts',
  'app/api/bookkeeping/journal-entries/[id]/references/route.ts',
  'app/api/bookkeeping/journal-entries/[id]/reverse/route.ts',
  'app/api/bookkeeping/journal-entries/[id]/route.ts',
  'app/api/bookkeeping/journal-entries/[id]/strike-lines/route.ts',
  'app/api/bookkeeping/journal-entries/[id]/transactions/route.ts',
  'app/api/bookkeeping/journal-entry-lines/[lineId]/retag/route.ts',
  'app/api/bookkeeping/tax-loss-carryforwards/[id]/route.ts',
  'app/api/budgets/[id]/copy-actuals/route.ts',
  'app/api/budgets/[id]/grid/route.ts',
  'app/api/budgets/[id]/import/preview/route.ts',
  'app/api/budgets/[id]/import/route.ts',
  'app/api/budgets/[id]/lines/route.ts',
  'app/api/budgets/[id]/spread/route.ts',
  'app/api/cash-accounts/[id]/primary/route.ts',
  'app/api/commitments/agreements/[id]/end/route.ts',
  'app/api/commitments/agreements/[id]/route.ts',
  'app/api/commitments/group-links/[id]/route.ts',
  'app/api/commitments/securities/[id]/route.ts',
  'app/api/company/[id]/migration-reset/archive/route.ts',
  'app/api/company/[id]/migration-reset/route.ts',
  'app/api/company/members/[id]/route.ts',
  'app/api/company/members/invite/[id]/route.ts',
  'app/api/deadlines/[id]/complete/route.ts',
  'app/api/dimensions/[id]/route.ts',
  'app/api/dimensions/[id]/values/route.ts',
  'app/api/dimensions/rules/[id]/route.ts',
  'app/api/documents/[id]/admission/route.ts',
  'app/api/documents/[id]/classification/route.ts',
  'app/api/documents/[id]/extraction/fields/route.ts',
  'app/api/documents/[id]/extraction/route.ts',
  'app/api/documents/[id]/inline/route.ts',
  'app/api/documents/[id]/link/route.ts',
  'app/api/documents/[id]/route.ts',
  'app/api/grants/[id]/revoke/route.ts',
  'app/api/import/bank-file/[id]/undo/route.ts',
  'app/api/import/sie/[id]/action/route.ts',
  'app/api/import/sie/[id]/replace/route.ts',
  'app/api/import/sie/[id]/undo/route.ts',
  'app/api/inkorg/items/[id]/book/route.ts',
  'app/api/inkorg/items/[id]/booking-plan/route.ts',
  'app/api/inkorg/items/[id]/companion/route.ts',
  'app/api/inkorg/items/[id]/register-and-settle/route.ts',
  'app/api/invoices/[id]/book/route.ts',
  'app/api/invoices/[id]/cancel/route.ts',
  'app/api/invoices/[id]/convert-to-order/route.ts',
  'app/api/invoices/[id]/convert/route.ts',
  'app/api/invoices/[id]/digital-mailbox/route.ts',
  'app/api/invoices/[id]/digital-mailbox/send/route.ts',
  'app/api/invoices/[id]/finalize/route.ts',
  'app/api/invoices/[id]/link-to-voucher/route.ts',
  'app/api/invoices/[id]/mark-paid/route.ts',
  'app/api/invoices/[id]/mark-sent/route.ts',
  'app/api/invoices/[id]/pdf/route.ts',
  'app/api/invoices/[id]/quote-status/route.ts',
  'app/api/invoices/[id]/resend/route.ts',
  'app/api/invoices/[id]/route.ts',
  'app/api/invoices/[id]/send-payment-confirmation/route.ts',
  'app/api/invoices/[id]/send/route.ts',
  'app/api/invoices/[id]/voucher-candidates/route.ts',
  'app/api/invoices/recurring/[id]/route.ts',
  'app/api/invoices/recurring/[id]/run/route.ts',
  'app/api/mileage/trips/[id]/route.ts',
  'app/api/packages/[packageId]/route.ts',
  'app/api/parties/[id]/enrich/candidates/route.ts',
  'app/api/parties/[id]/enrich/route.ts',
  'app/api/parties/[id]/route.ts',
  'app/api/payments/orders/[id]/cancel/route.ts',
  'app/api/payments/signing/[id]/poll/route.ts',
  'app/api/payments/signing/[id]/restart/route.ts',
  'app/api/payments/signing/[id]/second-signature/route.ts',
  'app/api/pending-operations/[id]/reject/route.ts',
  'app/api/pos-sales/connections/[id]/disconnect/route.ts',
  'app/api/pos-sales/connections/[id]/settings/route.ts',
  'app/api/pos-sales/days/[id]/book/route.ts',
  'app/api/pos-sales/days/[id]/report/route.ts',
  'app/api/pos-sales/days/[id]/route.ts',
  'app/api/questions/[id]/answer/route.ts',
  'app/api/questions/[id]/close/route.ts',
  'app/api/questions/[id]/reopen/route.ts',
  'app/api/reports/ar-ledger/customer/[customerId]/invoices/route.ts',
  'app/api/reports/supplier-ledger/supplier/[supplierId]/invoices/route.ts',
  'app/api/rot-rut/payout-requests/[id]/link-voucher/route.ts',
  'app/api/rot-rut/payout-requests/[id]/reclaim/route.ts',
  'app/api/rot-rut/payout-requests/[id]/route.ts',
  'app/api/rot-rut/payout-requests/[id]/settle/route.ts',
  'app/api/salary/employees/[id]/absence/route.ts',
  'app/api/salary/employees/[id]/worked-hours/batch/route.ts',
  'app/api/salary/employees/[id]/worked-hours/route.ts',
  'app/api/salary/runs/[id]/agi/xml/route.ts',
  'app/api/salary/runs/[id]/approve/route.ts',
  'app/api/salary/runs/[id]/book/route.ts',
  'app/api/salary/runs/[id]/calculate/route.ts',
  'app/api/salary/runs/[id]/correct/route.ts',
  'app/api/salary/runs/[id]/employees/route.ts',
  'app/api/salary/runs/[id]/lines/route.ts',
  'app/api/salary/runs/[id]/paid/route.ts',
  'app/api/salary/runs/[id]/payment/bank-list/pdf/route.ts',
  'app/api/salary/runs/[id]/payment/bank-list/route.ts',
  'app/api/salary/runs/[id]/payment/bg-lb/route.ts',
  'app/api/salary/runs/[id]/payment/pain001/route.ts',
  'app/api/salary/runs/[id]/payslips/[employeeId]/pdf/route.ts',
  'app/api/salary/runs/[id]/preview/route.ts',
  'app/api/salary/runs/[id]/revert/route.ts',
  'app/api/salary/runs/[id]/review/route.ts',
  'app/api/salary/runs/[id]/unapprove/route.ts',
  'app/api/salary/runs/[id]/underlag/pdf/route.ts',
  'app/api/sales-orders/[id]/create-invoice/route.ts',
  'app/api/sales-orders/[id]/deliver/route.ts',
  'app/api/sales-orders/[id]/route.ts',
  'app/api/sales-orders/[id]/transition/route.ts',
  'app/api/supplier-invoices/[id]/approve/route.ts',
  'app/api/supplier-invoices/[id]/attestations/route.ts',
  'app/api/supplier-invoices/[id]/bank-entered/route.ts',
  'app/api/supplier-invoices/[id]/book/route.ts',
  'app/api/supplier-invoices/[id]/credit/route.ts',
  'app/api/supplier-invoices/[id]/items/[itemId]/route.ts',
  'app/api/supplier-invoices/[id]/link-to-voucher/route.ts',
  'app/api/supplier-invoices/[id]/mark-paid/preview/route.ts',
  'app/api/supplier-invoices/[id]/mark-paid/route.ts',
  'app/api/supplier-invoices/[id]/reject/route.ts',
  'app/api/supplier-invoices/[id]/route.ts',
  'app/api/supplier-invoices/[id]/self-billing-pdf/route.ts',
  'app/api/supplier-invoices/[id]/uncredit/route.ts',
  'app/api/supplier-invoices/[id]/unlink-voucher/route.ts',
  'app/api/supplier-invoices/[id]/voucher-candidates/route.ts',
  'app/api/supplier-invoices/payment-batches/[id]/cancel/route.ts',
  'app/api/supplier-invoices/payment-batches/[id]/file/route.ts',
  'app/api/supplier-invoices/payment-batches/[id]/route.ts',
  'app/api/tax-assessment-notices/[id]/route.ts',
  'app/api/team/members/[id]/route.ts',
  'app/api/transactions/[id]/attach-document/route.ts',
  'app/api/transactions/[id]/book/route.ts',
  'app/api/transactions/[id]/cash-account/route.ts',
  'app/api/transactions/[id]/categorize/route.ts',
  'app/api/transactions/[id]/duplicate-payment-check/route.ts',
  'app/api/transactions/[id]/link-journal-entry/route.ts',
  'app/api/transactions/[id]/match-batch/route.ts',
  'app/api/transactions/[id]/match-expense-payout/route.ts',
  'app/api/transactions/[id]/match-invoice/route.ts',
  'app/api/transactions/[id]/match-rot-rut-payout/route.ts',
  'app/api/transactions/[id]/match-supplier-invoice/route.ts',
  'app/api/transactions/[id]/parts/route.ts',
  'app/api/transactions/[id]/refresh-exchange-rate/route.ts',
  'app/api/transactions/[id]/route.ts',
  'app/api/transactions/[id]/uncategorize/route.ts',
  'app/api/transactions/[id]/underlag/route.ts',
  'app/api/webshop-orders/[id]/book/route.ts',
  'app/api/webshop-orders/[id]/create-invoice/route.ts',
  'app/api/webshop-orders/[id]/mark-booked/route.ts',
  'app/api/webshop-orders/[id]/underlag/route.ts',
  'app/api/wiki/records/[kind]/[id]/route.ts',
])
