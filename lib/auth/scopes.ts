/**
 * v1 REST API endpoint → required scope map.
 *
 * This is the REST-route analogue of `TOOL_SCOPE_MAP` in api-keys.ts (which
 * maps MCP tool names to scopes). Both share the same `ApiKeyScope` registry.
 *
 * Key format: `<METHOD> <pattern>` where pattern uses `:param` for path
 * variables, matching Next.js dynamic-segment conventions (one for one).
 *
 * Endpoints not listed here are public (no auth): only the discovery routes
 * (`/llms.txt`, `/.well-known/skills`, `/api/v1/health`, `/api/v1/openapi.json`)
 * fall into that bucket. Everything else under `/api/v1/` MUST be in this map
 * or the wrapper will refuse the request with INSUFFICIENT_SCOPE.
 */

import type { ApiKeyScope } from './api-keys'

/**
 * Routes that require authentication but no scope check beyond "is the key
 * valid?". The wrapper still validates the key and runs rate limiting.
 */
export const V1_PUBLIC_ENDPOINTS: ReadonlyArray<string> = [
  'GET /api/v1/health',
  'GET /api/v1/openapi.json',
  'GET /api/v1/openapi.yaml',
]

/**
 * Map of v1 endpoint pattern → required scope.
 *
 * Patterns use `:param` placeholders that match a single path segment.
 * The wrapper compiles these into regexes at startup and matches incoming
 * requests by (method, normalized-path) tuple.
 *
 * When adding a new endpoint, add it here BEFORE shipping the route file:
 * otherwise the wrapper will reject all requests to it.
 */
export const V1_ENDPOINT_SCOPES: Record<string, ApiKeyScope> = {
  // Companies
  'GET /api/v1/companies': 'companies:read',
  'GET /api/v1/companies/:companyId': 'companies:read',

  // Operations (async long-running tasks)
  'GET /api/v1/operations/:id': 'operations:read',

  // Events (webhook fallback / event log polling)
  'GET /api/v1/companies/:companyId/events': 'events:read',

  // Customers (Phase 2 PR-A: reads; Phase 2 PR-B-1: writes)
  'GET /api/v1/companies/:companyId/customers': 'customers:read',
  'GET /api/v1/companies/:companyId/customers/:id': 'customers:read',
  'POST /api/v1/companies/:companyId/customers': 'customers:write',
  'PATCH /api/v1/companies/:companyId/customers/:id': 'customers:write',
  'DELETE /api/v1/companies/:companyId/customers/:id': 'customers:write',

  // Invoices (Phase 2 PR-A: reads; Phase 2 PR-B-2a: draft writes)
  'GET /api/v1/companies/:companyId/invoices': 'invoices:read',
  'GET /api/v1/companies/:companyId/invoices/:id': 'invoices:read',
  'POST /api/v1/companies/:companyId/invoices': 'invoices:write',
  'PATCH /api/v1/companies/:companyId/invoices/:id': 'invoices:write',
  // Phase 2 PR-B-2b: action verbs. URL uses /verb subpath (not Google-AIP-style :verb)
  // because Next.js routes don't support `:` in folder names.
  'POST /api/v1/companies/:companyId/invoices/:id/mark-sent': 'invoices:write',
  'POST /api/v1/companies/:companyId/invoices/:id/mark-paid': 'invoices:write',
  'POST /api/v1/companies/:companyId/invoices/:id/credit': 'invoices:write',
  'POST /api/v1/companies/:companyId/invoices/:id/send': 'invoices:write',
  'POST /api/v1/companies/:companyId/invoices/bulk-create': 'invoices:write',
  // Phase 2 PR-B-3: invoice PDF + customer bulk-create.
  'GET /api/v1/companies/:companyId/invoices/:id/pdf': 'invoices:read',
  'POST /api/v1/companies/:companyId/customers/bulk-create': 'customers:write',

  // Phase 4 PR-1: Suppliers + Supplier-invoices verticals (AP world).
  // Suppliers
  'GET /api/v1/companies/:companyId/suppliers': 'suppliers:read',
  'GET /api/v1/companies/:companyId/suppliers/:id': 'suppliers:read',
  'POST /api/v1/companies/:companyId/suppliers': 'suppliers:write',
  'PATCH /api/v1/companies/:companyId/suppliers/:id': 'suppliers:write',
  'DELETE /api/v1/companies/:companyId/suppliers/:id': 'suppliers:write',
  'POST /api/v1/companies/:companyId/suppliers/bulk-create': 'suppliers:write',
  // Supplier invoices
  'GET /api/v1/companies/:companyId/supplier-invoices': 'suppliers:read',
  'GET /api/v1/companies/:companyId/supplier-invoices/:id': 'suppliers:read',
  'POST /api/v1/companies/:companyId/supplier-invoices': 'suppliers:write',
  'PATCH /api/v1/companies/:companyId/supplier-invoices/:id': 'suppliers:write',
  // Note: no DELETE: supplier-invoice withdrawal is via :credit (mirrors v1 invoices).
  'POST /api/v1/companies/:companyId/supplier-invoices/:id/approve': 'suppliers:write',
  'POST /api/v1/companies/:companyId/supplier-invoices/:id/mark-paid': 'suppliers:write',
  'POST /api/v1/companies/:companyId/supplier-invoices/:id/credit': 'suppliers:write',

  // Phase 4 PR-2: Engine, periods async ops, documents, compliance-check.
  // Journal-entries primitives (highest-risk surface).
  'GET /api/v1/companies/:companyId/journal-entries': 'reports:read',
  'GET /api/v1/companies/:companyId/journal-entries/:id': 'reports:read',
  'POST /api/v1/companies/:companyId/journal-entries': 'bookkeeping:write',
  'POST /api/v1/companies/:companyId/journal-entries/:id/commit': 'bookkeeping:write',
  'POST /api/v1/companies/:companyId/journal-entries/:id/reverse': 'bookkeeping:write',
  'POST /api/v1/companies/:companyId/journal-entries/:id/correct': 'bookkeeping:write',
  'POST /api/v1/companies/:companyId/journal-entries/batch-create': 'bookkeeping:write',
  'POST /api/v1/companies/:companyId/voucher-gap-explanations': 'bookkeeping:write',
  // Fiscal-periods async ops.
  'POST /api/v1/companies/:companyId/fiscal-periods/:id/lock': 'bookkeeping:write',
  'POST /api/v1/companies/:companyId/fiscal-periods/:id/close': 'bookkeeping:write',
  'POST /api/v1/companies/:companyId/fiscal-periods/:id/year-end': 'bookkeeping:write',
  'POST /api/v1/companies/:companyId/fiscal-periods/:id/opening-balances': 'bookkeeping:write',
  'POST /api/v1/companies/:companyId/fiscal-periods/:id/currency-revaluation': 'bookkeeping:write',
  // Compliance check (Accounted's defensible edge).
  'GET /api/v1/companies/:companyId/compliance/check': 'compliance:read',
  // Phase 4 PR-3: Documents (multipart).
  'POST /api/v1/companies/:companyId/documents': 'documents:write',
  'GET /api/v1/companies/:companyId/documents/:id/download': 'documents:read',
  'POST /api/v1/companies/:companyId/documents/:id/link': 'documents:write',

  // Phase 3: transactions + reconciliation vertical.
  // Reads
  'GET /api/v1/companies/:companyId/transactions': 'transactions:read',
  'GET /api/v1/companies/:companyId/transactions/:id': 'transactions:read',
  'GET /api/v1/companies/:companyId/accounts': 'reports:read',
  'GET /api/v1/companies/:companyId/fiscal-periods': 'reports:read',
  // Writes: single transaction verbs
  'POST /api/v1/companies/:companyId/transactions/:id/categorize': 'transactions:write',
  'POST /api/v1/companies/:companyId/transactions/:id/uncategorize': 'transactions:write',
  'POST /api/v1/companies/:companyId/transactions/:id/match-invoice': 'transactions:write',
  'POST /api/v1/companies/:companyId/transactions/:id/match-supplier-invoice': 'transactions:write',
  // Writes: bulk
  'POST /api/v1/companies/:companyId/transactions/ingest': 'transactions:write',
  'POST /api/v1/companies/:companyId/transactions/batch-categorize': 'transactions:write',
  // Reconciliation
  'POST /api/v1/companies/:companyId/reconciliation/bank/run': 'transactions:write',
  'GET /api/v1/companies/:companyId/reconciliation/bank/status': 'transactions:read',

  // Phase 5 PR-3: Reports + import async. Reports are read-only over
  // existing lib/reports/* generators; imports are async over the Phase 4
  // PR-2 operations substrate.
  // JSON reports: all share `reports:read` (or `payroll:read` for the
  // salary-scoped ones). kpi, audit-trail, periodisk-sammanstallning,
  // ne-bilaga, and ink2 are deferred to a follow-up PR: kpi composes
  // multiple lib generators rather than wrapping one; audit-trail lives in
  // lib/core/audit/ rather than lib/reports/; ne-bilaga + ink2 + periodisk
  // each have their own lib subdir structure that needs more care.
  'GET /api/v1/companies/:companyId/reports/trial-balance': 'reports:read',
  'GET /api/v1/companies/:companyId/reports/balance-sheet': 'reports:read',
  'GET /api/v1/companies/:companyId/reports/income-statement': 'reports:read',
  'GET /api/v1/companies/:companyId/reports/general-ledger': 'reports:read',
  'GET /api/v1/companies/:companyId/reports/journal-register': 'reports:read',
  'GET /api/v1/companies/:companyId/reports/vat-declaration': 'reports:read',
  'GET /api/v1/companies/:companyId/reports/monthly-breakdown': 'reports:read',
  'GET /api/v1/companies/:companyId/reports/ar-ledger': 'reports:read',
  'GET /api/v1/companies/:companyId/reports/supplier-ledger': 'reports:read',
  'GET /api/v1/companies/:companyId/reports/continuity-check': 'reports:read',
  'GET /api/v1/companies/:companyId/reports/salary-journal': 'payroll:read',
  'GET /api/v1/companies/:companyId/reports/avgifter-basis': 'payroll:read',
  'GET /api/v1/companies/:companyId/reports/vacation-liability': 'payroll:read',
  // Binary report: SIE4 text/plain export. JSON variants of INK2 / NE-bilaga
  // are deferred (see above).
  'GET /api/v1/companies/:companyId/reports/sie-export': 'reports:read',
  // Imports: async via the Phase 4 PR-2 operations substrate. Multipart
  // uploads (the file is the request body).
  'POST /api/v1/companies/:companyId/imports/sie': 'bookkeeping:write',
  'POST /api/v1/companies/:companyId/imports/bank': 'transactions:write',

  // Phase 5 PR-1: Payroll vertical (employees + salary-runs + lifecycle verbs).
  // Reuses the pre-existing `payroll:read` / `payroll:write` scopes already
  // defined for the MCP tool surface (gnubok_list_employees, gnubok_create_salary_run, ...).
  // Employees (soft-delete via is_active: no archived_at column).
  'GET /api/v1/companies/:companyId/employees': 'payroll:read',
  'GET /api/v1/companies/:companyId/employees/:id': 'payroll:read',
  'POST /api/v1/companies/:companyId/employees': 'payroll:write',
  'PATCH /api/v1/companies/:companyId/employees/:id': 'payroll:write',
  'DELETE /api/v1/companies/:companyId/employees/:id': 'payroll:write',
  // Salary runs (state machine: draft → review → approved → paid → booked).
  'GET /api/v1/companies/:companyId/salary-runs': 'payroll:read',
  'GET /api/v1/companies/:companyId/salary-runs/:id': 'payroll:read',
  'POST /api/v1/companies/:companyId/salary-runs': 'payroll:write',
  'PATCH /api/v1/companies/:companyId/salary-runs/:id': 'payroll:write',
  'DELETE /api/v1/companies/:companyId/salary-runs/:id': 'payroll:write',
  // Salary-run lifecycle verbs: v1 :calculate collapses internal /calculate
  // (math) + /review (state advance) so an agent has one verb per logical step.
  'POST /api/v1/companies/:companyId/salary-runs/:id/calculate': 'payroll:write',
  'POST /api/v1/companies/:companyId/salary-runs/:id/approve': 'payroll:write',
  'POST /api/v1/companies/:companyId/salary-runs/:id/mark-paid': 'payroll:write',
  'POST /api/v1/companies/:companyId/salary-runs/:id/book': 'payroll:write',
  'POST /api/v1/companies/:companyId/salary-runs/:id/generate-agi': 'payroll:write',

  // Dimensions (kostnadsställe/projekt): dimensions PR2. Reads ride
  // reports:read (registry data feeds report filters/pickers); value creation
  // is bookkeeping:write (it mints codes that journal lines reference).
  'GET /api/v1/companies/:companyId/dimensions': 'reports:read',
  'POST /api/v1/companies/:companyId/dimensions/:id/values': 'bookkeeping:write',
  // Value lifecycle (#895): rename/archive/end-date via PATCH; DELETE only
  // succeeds for unreferenced values (BFL retention trigger guards the rest).
  'PATCH /api/v1/companies/:companyId/dimensions/:id/values/:valueId': 'bookkeeping:write',
  'DELETE /api/v1/companies/:companyId/dimensions/:id/values/:valueId': 'bookkeeping:write',

  // Articles (artikelregister, #895): read-only list so invoice items can
  // link article_id / copy housework_type + revenue_account. Rides
  // invoices:read (the register exists to serve invoicing).
  'GET /api/v1/companies/:companyId/articles': 'invoices:read',

  // Webhooks (Phase 6 PR-1)
  'GET /api/v1/companies/:companyId/webhooks': 'webhooks:manage',
  'POST /api/v1/companies/:companyId/webhooks': 'webhooks:manage',
  'GET /api/v1/companies/:companyId/webhooks/:id': 'webhooks:manage',
  'PATCH /api/v1/companies/:companyId/webhooks/:id': 'webhooks:manage',
  'DELETE /api/v1/companies/:companyId/webhooks/:id': 'webhooks:manage',
  'POST /api/v1/companies/:companyId/webhooks/:id/test': 'webhooks:manage',
  'GET /api/v1/companies/:companyId/webhooks/:id/deliveries': 'webhooks:manage',
  'POST /api/v1/companies/:companyId/webhooks/:id/rotate-secret': 'webhooks:manage',
  'POST /api/v1/webhook-deliveries/:id/retry': 'webhooks:manage',
}

interface CompiledRoute {
  method: string
  regex: RegExp
  scope: ApiKeyScope
}

let compiledCache: CompiledRoute[] | null = null

function compileAll(): CompiledRoute[] {
  if (compiledCache) return compiledCache
  compiledCache = Object.entries(V1_ENDPOINT_SCOPES).map(([pattern, scope]) => {
    const [method, path] = pattern.split(' ', 2)
    const regexStr = '^' + path.replace(/:[^/]+/g, '[^/]+') + '$'
    return { method, regex: new RegExp(regexStr), scope }
  })
  return compiledCache
}

/**
 * Resolve the required scope for a given (method, path) request.
 *
 * - Returns the scope when a registered v1 endpoint matches.
 * - Returns 'public' for paths in V1_PUBLIC_ENDPOINTS (no scope check needed,
 *   but the wrapper may still want to log the key id).
 * - Returns null when the path is unknown: the wrapper should treat this as
 *   a 404 NOT_FOUND rather than letting the request through unauthenticated.
 */
export function resolveRequiredScope(method: string, path: string): ApiKeyScope | 'public' | null {
  const key = `${method} ${path}`

  if (V1_PUBLIC_ENDPOINTS.includes(key)) return 'public'

  const compiled = compileAll()
  for (const route of compiled) {
    if (route.method === method && route.regex.test(path)) {
      return route.scope
    }
  }

  return null
}
