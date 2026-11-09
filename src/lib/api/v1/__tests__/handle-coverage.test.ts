/**
 * Typed-handle coverage of the v1 surface (./handles.ts, lib/handles).
 *
 * Pins three things so coverage can only grow:
 *   1. Every V1_HANDLE_COVERAGE entry names a registered endpoint and the
 *      published spec carries `handle` where the response layer stamps it.
 *   2. Every endpoint whose response has a bare `id` at a resource position
 *      (data, data[], data.<key>, data.<key>[]) is covered, or on
 *      HANDLE_FOLLOW_UPS with its reason. The list may only shrink: a new
 *      endpoint answering an `id` must declare its handle (or give its
 *      resource a prefix first).
 *   3. The type every v1 path parameter takes, by the segment before it.
 */
import { describe, expect, it } from 'vitest'
import { pathParamTypes } from '@/lib/handles'
import { listEndpoints, responseJsonSchema, zodToJsonSchema, type JsonSchema } from '../registry'
import { V1_HANDLE_COVERAGE } from '../handles'
// Side-effect import: every route file registers its endpoint.
import '../load-routes'

/**
 * Endpoints answering a bare `id` that do not stamp a handle yet. Remove a
 * line when its endpoint gains coverage (the test fails on a stale line);
 * never add one for a resource that has a prefix.
 */
const HANDLE_FOLLOW_UPS: Readonly<Record<string, string>> = {
  'accounts.create': 'no prefix by design: an account is addressed by its account_number',
  'accounts.update': 'no prefix by design: an account is addressed by its account_number',
}
/** HANDLE_FOLLOW_UPS may shrink, never grow past this. */
const MAX_FOLLOW_UPS = 2

/**
 * Endpoints whose `id` is not a resource UUID, so no handle can ever apply.
 * Not a follow-up: there is nothing missing.
 */
const NOT_A_RESOURCE_ID: Readonly<Record<string, string>> = {
  'capabilities.get': 'data.modules[].id is a module name (ledger, bank-feed, ...), not a UUID',
}

function unwrap(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema) return undefined
  const options = schema.anyOf ?? schema.oneOf
  if (options) return unwrap(options.find((o) => o.type !== 'null'))
  return schema
}

function isArray(schema: JsonSchema): boolean {
  return schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'))
}

/** The resource positions of a success schema that carry a property (`id`, `handle`). */
function positionsWith(success: JsonSchema, property: string): string[] {
  const found: string[] = []
  const visit = (node: JsonSchema | undefined, where: string, depth: number) => {
    const s = unwrap(node)
    if (!s) return
    if (isArray(s)) return visit(s.items, `${where}[]`, depth)
    if (!s.properties) return
    if (property in s.properties) found.push(where)
    if (depth > 0) return
    for (const [key, value] of Object.entries(s.properties)) visit(value, `${where}.${key}`, depth + 1)
  }
  visit(success.properties?.data, 'data', 0)
  return found
}

const endpoints = listEndpoints()
const operations = new Set(endpoints.map((e) => e.operation))

describe('V1_HANDLE_COVERAGE', () => {
  it('names registered operations only', () => {
    expect(Object.keys(V1_HANDLE_COVERAGE).filter((op) => !operations.has(op))).toEqual([])
  })

  it('publishes handle in the spec at the position each entry declares', () => {
    const missing: string[] = []
    for (const e of endpoints) {
      const decl = V1_HANDLE_COVERAGE[e.operation]
      if (!decl) continue
      const where = decl.at ? `data.${decl.at}` : 'data'
      const positions = positionsWith(responseJsonSchema(e), 'handle')
      if (!positions.some((p) => p === where || p === `${where}[]`)) missing.push(`${e.operation} (${where})`)
    }
    expect(missing, 'the declared id field is not in the registered response schema').toEqual([])
  })

  it('stamps nothing on an endpoint it does not cover (the spec is unchanged there)', () => {
    for (const e of endpoints) {
      if (V1_HANDLE_COVERAGE[e.operation]) continue
      expect(responseJsonSchema(e), e.operation).toEqual(zodToJsonSchema(e.response.success))
    }
  })
})

describe('handle coverage ratchet', () => {
  const answersBareId = endpoints.filter((e) => positionsWith(zodToJsonSchema(e.response.success), 'id').length > 0)

  it('covers every endpoint that answers a bare id, or lists it as a follow-up', () => {
    const uncovered = answersBareId
      .filter(
        (e) => !V1_HANDLE_COVERAGE[e.operation] && !HANDLE_FOLLOW_UPS[e.operation] && !NOT_A_RESOURCE_ID[e.operation],
      )
      .map((e) => `${e.operation} (${e.method} ${e.path})`)
    expect(
      uncovered,
      'add the endpoint to V1_HANDLE_COVERAGE in lib/api/v1/handles.ts (give its resource a prefix in lib/handles/registry.ts if it has none)',
    ).toEqual([])
  })

  it('keeps the follow-up list honest: no stale or unknown lines, and it only shrinks', () => {
    const stale = Object.keys(HANDLE_FOLLOW_UPS).filter(
      (op) => !operations.has(op) || V1_HANDLE_COVERAGE[op] || !answersBareId.some((e) => e.operation === op),
    )
    expect(stale, 'remove these lines from HANDLE_FOLLOW_UPS').toEqual([])
    expect(Object.keys(HANDLE_FOLLOW_UPS).length).toBeLessThanOrEqual(MAX_FOLLOW_UPS)
  })

  it('exempts only registered endpoints that still answer a bare id', () => {
    const stale = Object.keys(NOT_A_RESOURCE_ID).filter(
      (op) => !operations.has(op) || !answersBareId.some((e) => e.operation === op),
    )
    expect(stale, 'remove these lines from NOT_A_RESOURCE_ID').toEqual([])
  })
})

describe('path parameter typing', () => {
  it('types each v1 path parameter by the collection segment before it', () => {
    const typing: Record<string, string | null> = {}
    for (const e of endpoints) {
      const segments = e.path.split('/')
      for (const [param, type] of Object.entries(pathParamTypes(e.path))) {
        const before = segments[segments.indexOf(`:${param}`) - 1]
        typing[`${before}/:${param}`] = type
      }
    }
    expect(Object.fromEntries(Object.entries(typing).sort(([a], [b]) => a.localeCompare(b)))).toEqual({
      'accounts/:accountKey': null,
      'accounts/:number': null,
      'accrual-schedules/:id': 'accrual_schedule',
      'agreements/:id': null,
      'assets/:id': 'asset',
      'attest-substitutes/:id': null,
      'bank-connections/:connectionId': null,
      'bank/:id': null,
      'banks/:bic': null,
      'benefits/:benefitId': null,
      'budgets/:id': null,
      'capital-changes/:id': null,
      'cash-accounts/:id': 'cash_account',
      'companies/:companyId': 'company',
      'components/:componentId': null,
      'company-roles/:id': null,
      'corporate-meetings/:id': null,
      'connections/:connectionId': null,
      'customers/:id': 'customer',
      'days/:dayId': null,
      'dividends/:id': null,
      'dimensions/:id': 'dimension',
      'documents/:id': 'document',
      'employees/:employeeId': 'employee',
      'employees/:id': 'employee',
      'expense-claims/:id': 'expense_claim',
      'fiscal-periods/:id': 'fiscal_period',
      'group-links/:id': null,
      'inbox-items/:id': 'inbox_item',
      'invoices/:id': 'invoice',
      'items/:itemId': null,
      'journal-entries/:id': 'journal_entry',
      'k10/:year': null,
      'keys/:keyId': 'api_key',
      'ku20/:year': null,
      'ku31/:year': null,
      'lines/:lineId': null,
      'links/:linkId': null,
      'measures/:measureId': null,
      'merges/:mergeId': null,
      'unexplained/:checkId': null,
      'operations/:id': 'operation',
      'owner-loans/:id': null,
      'owners/:partyId': null,
      'packages/:packageId': null,
      'payment-orders/:id': 'payment_order',
      'payments/:paymentId': null,
      'payslips/:employeeId': 'employee',
      'pending-operations/:id': 'pending_operation',
      'premium-rules/:id': null,
      'recurring-lines/:lineId': null,
      'rules/:id': null,
      'salary-runs/:id': 'salary_run',
      'securities/:id': null,
      'sie/:id': null,
      'signatures/:signatureId': null,
      'signers/:signerId': null,
      'signing-requests/:id': null,
      'versions/:versionId': null,
      'signoff/:signoffId': 'reconciliation_signoff',
      'supplier-invoices/:id': 'supplier_invoice',
      'service-accounts/:id': 'service_account',
      'settlements/:settlementId': null,
      'share-classes/:id': null,
      'supplier-payment-batches/:id': 'supplier_payment_batch',
      'suppliers/:id': 'supplier',
      'tax-loss-carryforwards/:id': null,
      'transactions/:id': 'transaction',
      'underlag/:documentId': 'document',
      'values/:valueId': 'dimension_value',
      'webhook-deliveries/:id': 'webhook_delivery',
      'webhooks/:id': 'webhook',
      'webshop-orders/:orderId': null,
    })
  })
})
