/**
 * Typed handles on the v1 surface (lib/handles has the format).
 *
 * Input, for every v1 request, in withApiV1: a handle in a path parameter,
 * a query parameter or a JSON body field becomes the plain UUID before the
 * company gate, the idempotency hash and the handler see it, so every route
 * accepts handles without knowing they exist. A handle of the wrong type is
 * refused with 400 HANDLE_TYPE_MISMATCH. A request without handles is passed
 * on as the very same Request object: nothing about it changes.
 *
 * Output, for the endpoints in V1_HANDLE_COVERAGE: the response's resource
 * objects gain `handle` right after their id field. Existing fields and
 * their values never change; an object that already has a `handle` key, or
 * whose id is not a UUID, is left alone. The published spec (registry.ts
 * responseJsonSchema) adds the same property from the same table, so a strict
 * client validating against openapi.json accepts it. Dry runs, staged writes
 * (handled in lib/operations/v1.ts) and errors are not decorated.
 *
 * Coverage is pinned by __tests__/handle-coverage.test.ts: an endpoint
 * answering a bare `id` is either covered here or on its follow-up list, and
 * that list may only shrink.
 *
 * Light on purpose: withApiV1 loads it on every request.
 */
import { NextResponse } from 'next/server'
import {
  handlePattern,
  handleResource,
  normalizeHandleFields,
  normalizeHandlePath,
  normalizeQueryValue,
  parseHandle,
  pathParamTypes,
  toHandle,
  type HandleMismatch,
  type HandleType,
} from '@/lib/handles'
import { UUID_RE } from '@/lib/invariants/uuid'
import type { JsonSchema } from './registry'

/** Where an endpoint's response holds its resource objects, and of which type. */
export interface HandleDeclaration {
  type: HandleType
  /** The resource's own id field. Default `id`. */
  idField?: string
  /**
   * The `data` key holding the resource (object) or resources (array), for
   * the endpoints that wrap them (`{ data: { fiscal_periods: [...] } }`).
   * Omitted when `data` is the resource or the list of resources.
   */
  at?: string
}

const JE: HandleDeclaration = { type: 'journal_entry' }
const INV: HandleDeclaration = { type: 'invoice' }
const SINV: HandleDeclaration = { type: 'supplier_invoice' }
const TXN: HandleDeclaration = { type: 'transaction' }
const DOC: HandleDeclaration = { type: 'document' }
const DOC_QUALIFIED: HandleDeclaration = { type: 'document', idField: 'document_id' }
const POP: HandleDeclaration = { type: 'pending_operation', idField: 'pending_operation_id' }
const CUS: HandleDeclaration = { type: 'customer' }
const SUP: HandleDeclaration = { type: 'supplier' }
const CMP: HandleDeclaration = { type: 'company' }
const FP: HandleDeclaration = { type: 'fiscal_period' }
const EMP: HandleDeclaration = { type: 'employee' }
const SRUN: HandleDeclaration = { type: 'salary_run' }
const WH: HandleDeclaration = { type: 'webhook' }
const AST: HandleDeclaration = { type: 'asset' }
const DIM: HandleDeclaration = { type: 'dimension' }
const DIMV: HandleDeclaration = { type: 'dimension_value' }
const INBX: HandleDeclaration = { type: 'inbox_item', idField: 'inbox_item_id' }
const EXP: HandleDeclaration = { type: 'expense_claim', idField: 'expense_claim_id' }
const CASH: HandleDeclaration = { type: 'cash_account', idField: 'cash_account_id' }
const PMT: HandleDeclaration = { type: 'payment_order', idField: 'payment_order_id' }
const SPB: HandleDeclaration = { type: 'supplier_payment_batch', idField: 'supplier_payment_batch_id' }
const RSO: HandleDeclaration = { type: 'reconciliation_signoff', at: 'signoff' }

/** The staged-write 202 (a pending operation), for lib/operations/v1.ts. */
export const STAGED_PENDING_OPERATION_HANDLES: HandleDeclaration = POP

/**
 * Which endpoints answer which resource, by operation id (unique across
 * the v1 registry). The response layer stamps `handle` from this table and
 * the spec publishes it from the same entry.
 */
export const V1_HANDLE_COVERAGE: Readonly<Record<string, HandleDeclaration>> = Object.freeze({
  // Companies
  'companies.list': CMP,
  'companies.create': CMP,
  'api-key.get': { type: 'company', at: 'companies' },

  // Journal entries
  'journal-entries.list': JE,
  'journal-entries.get': JE,
  'journal-entries.create-draft': JE,
  'journal-entries.update-draft': JE,
  'journal-entries.commit': JE,
  'journal-entries.cancel': JE,

  // Customer invoices
  'invoices.list': INV,
  'invoices.get': INV,
  'invoices.create': INV,
  'invoices.update': INV,
  'invoices.cancel': INV,
  'invoices.credit': INV,
  'invoices.mark-paid': INV,
  'invoices.mark-sent': INV,
  'invoices.quote-status': INV,
  'invoices.send': INV,
  'invoices.book': { type: 'invoice', at: 'invoice' },
  'invoices.bulk-book': { type: 'invoice', at: 'results' },

  // Supplier invoices
  'supplier-invoices.list': SINV,
  'supplier-invoices.get': SINV,
  'supplier-invoices.create': SINV,
  'supplier-invoices.update': SINV,
  'supplier-invoices.approve': SINV,
  'supplier-invoices.mark-paid': SINV,
  'supplier-invoices.book': { type: 'supplier_invoice', at: 'supplier_invoice' },

  // Bank transactions
  'transactions.list': TXN,
  'transactions.get': TXN,
  'transactions.update': TXN,

  // Documents
  'documents.list': { type: 'document', idField: 'document_id', at: 'documents' },
  'documents.get': DOC_QUALIFIED,
  'documents.upload': DOC,
  'documents.download': DOC,
  'documents.link': DOC,

  // Pending operations (the staged 202 is stamped in lib/operations/v1.ts)
  'pending-operations.list': POP,
  'pending-operations.get': POP,
  'pending-operations.approve': POP,
  'pending-operations.reject': POP,

  // Parties
  'customers.list': CUS,
  'customers.get': CUS,
  'customers.create': CUS,
  'customers.update': CUS,
  'suppliers.list': SUP,
  'suppliers.get': SUP,
  'suppliers.create': SUP,
  'suppliers.update': SUP,

  // Fiscal periods
  'fiscal-periods.list': { type: 'fiscal_period', at: 'fiscal_periods' },
  'fiscal-periods.create': { type: 'fiscal_period', at: 'fiscal_period' },
  'fiscal-periods.update': FP,
  'fiscal-periods.close': FP,
  'fiscal-periods.lock': FP,
  'fiscal-periods.unlock': FP,
  'fiscal-periods.close-external': FP,
  'fiscal-periods.reopen-external': FP,
  'fiscal-periods.delete': FP,

  // Payroll
  'employees.list': EMP,
  'employees.get': EMP,
  'employees.create': EMP,
  'employees.update': EMP,
  'salary-runs.list': SRUN,
  'salary-runs.get': SRUN,
  'salary-runs.create': SRUN,
  'salary-runs.update': SRUN,
  'salary-runs.approve': SRUN,
  'salary-runs.book': SRUN,
  'salary-runs.calculate': SRUN,
  'salary-runs.mark-paid': SRUN,
  'salary-runs.correct': { type: 'salary_run', at: 'correction_run' },

  // Webhooks
  'service-accounts.list': { type: 'service_account', at: 'service_accounts' },
  'service-accounts.create': { type: 'service_account' },
  'service-accounts.get': { type: 'service_account' },
  'service-accounts.revoke': { type: 'service_account' },
  'service-accounts.keys.create': { type: 'api_key' },
  'service-accounts.keys.revoke': { type: 'api_key' },
  'webhooks.list': { type: 'webhook', at: 'webhooks' },
  'webhooks.get': WH,
  'webhooks.create': WH,
  'webhooks.update': WH,
  'webhooks.rotate_secret': WH,
  'webhooks.verify': WH,
  'webhooks.deliveries.list': { type: 'webhook_delivery' },

  // Fixed assets and articles
  'assets.list': { type: 'asset', at: 'assets' },
  'assets.get': AST,
  'assets.create': AST,
  'assets.update': AST,
  'assets.dispose': { type: 'asset', at: 'asset' },
  'articles.list': { type: 'article', at: 'articles' },

  // Dimensions
  'dimensions.list': { type: 'dimension', at: 'dimensions' },
  'dimensions.create': { type: 'dimension', at: 'dimension' },
  'dimensions.update': DIM,
  'dimensions.values.create': DIMV,
  'dimensions.values.update': DIMV,
  'dimensions.values.delete': DIMV,

  // Inbox, expense claims, cash accounts, payments
  'inbox-items.list': { ...INBX, at: 'inbox_items' },
  'inbox-items.get': INBX,
  'inbox-items.update-extracted-data': INBX,
  'inbox-items.stamp': { type: 'inbox_item' },
  'expense-claims.list': { ...EXP, at: 'expense_claims' },
  'expense-claims.get': EXP,
  'expense-claims.create': EXP,
  'cash-accounts.list': { ...CASH, at: 'cash_accounts' },
  'cash-accounts.create': CASH,
  'cash-accounts.update': CASH,
  'cash-accounts.set-primary': CASH,
  'payment-orders.list': { ...PMT, at: 'payment_orders' },
  'payment-orders.get': PMT,
  'payment-orders.prepare': { ...PMT, at: 'payment_orders' },
  'supplier-payment-batches.list': { ...SPB, at: 'supplier_payment_batches' },
  'supplier-payment-batches.get': SPB,
  'supplier-payment-batches.create': SPB,

  // Async operations
  'operations.get': { type: 'operation', idField: 'operation_id' },

  // Audit log, reconciliation sign-offs, voucher gaps, byrå teams
  'audit-trail.list': { type: 'audit_log_entry', at: 'entries' },
  'reconciliation.accounts.status': RSO,
  'reconciliation.accounts.signoff.list': { type: 'reconciliation_signoff', at: 'signoffs' },
  'reconciliation.accounts.signoff.create': RSO,
  'reconciliation.accounts.signoff.reopen': RSO,
  'voucher-gap-explanations.create': { type: 'voucher_gap_explanation' },
  'portfolio.overview': { type: 'team', at: 'team' },
})

export function handleDeclarationFor(operation: string): HandleDeclaration | undefined {
  return Object.prototype.hasOwnProperty.call(V1_HANDLE_COVERAGE, operation)
    ? V1_HANDLE_COVERAGE[operation]
    : undefined
}

// ──────────────────────────────────────────────────────────────────
// Output: stamp `handle` next to the id
// ──────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One resource object with `handle` inserted after its id field, or the same object. */
function stampOne(obj: unknown, type: HandleType, idField: string): { value: unknown; changed: boolean } {
  if (!isPlainObject(obj) || 'handle' in obj) return { value: obj, changed: false }
  const handle = toHandle(type, obj[idField])
  if (handle === null) return { value: obj, changed: false }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    out[key] = value
    if (key === idField) out.handle = handle
  }
  return { value: out, changed: true }
}

function stampResources(node: unknown, type: HandleType, idField: string): { value: unknown; changed: boolean } {
  if (!Array.isArray(node)) return stampOne(node, type, idField)
  let changed = false
  const out = node.map((item) => {
    const r = stampOne(item, type, idField)
    changed ||= r.changed
    return r.value
  })
  return changed ? { value: out, changed } : { value: node, changed: false }
}

/**
 * `data` with `handle` stamped on its resource objects per the declaration:
 * a new value when anything was stamped, else the same value.
 */
export function addHandles(data: unknown, decl: HandleDeclaration): { value: unknown; changed: boolean } {
  const idField = decl.idField ?? 'id'
  if (decl.at === undefined) return stampResources(data, decl.type, idField)
  if (!isPlainObject(data) || !(decl.at in data)) return { value: data, changed: false }
  const inner = stampResources(data[decl.at], decl.type, idField)
  if (!inner.changed) return { value: data, changed: false }
  return { value: { ...data, [decl.at]: inner.value }, changed: true }
}

/** Status codes whose body is the resource itself (not a dry run, a staging or an error). */
const DECORATED_STATUSES = new Set([200, 201])

/**
 * The handler's response with handles stamped per the declaration, or the
 * same response when there is nothing to stamp. Status and every header are
 * kept; only the JSON body gains `handle` fields.
 */
export async function withResponseHandles(response: Response, decl: HandleDeclaration): Promise<Response> {
  if (!DECORATED_STATUSES.has(response.status)) return response
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return response
  const body = (await response.clone().json().catch(() => null)) as Record<string, unknown> | null
  if (!isPlainObject(body) || !('data' in body)) return response
  const stamped = addHandles(body.data, decl)
  if (!stamped.changed) return response
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return NextResponse.json({ ...body, data: stamped.value }, { status: response.status, headers })
}

// ──────────────────────────────────────────────────────────────────
// Spec: publish the property the response layer adds
// ──────────────────────────────────────────────────────────────────

function handleProperty(type: HandleType): JsonSchema & { pattern: string } {
  const r = handleResource(type)
  return {
    type: 'string',
    pattern: handlePattern(type),
    description: `Typed handle of this ${r.label}: ${r.prefix}_ plus its id as 32 lowercase hex. Accepted wherever the id is.`,
  }
}

/** The object schema with `handle` after its id property, or undefined when the shape does not fit. */
function addHandleProperty(schema: JsonSchema | undefined, type: HandleType, idField: string): JsonSchema | undefined {
  if (!schema) return undefined
  if (schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'))) {
    const items = addHandleProperty(schema.items, type, idField)
    return items ? { ...schema, items } : undefined
  }
  const props = schema.properties
  if (!props || !(idField in props) || 'handle' in props) return undefined
  const properties: Record<string, JsonSchema> = {}
  for (const [key, value] of Object.entries(props)) {
    properties[key] = value
    if (key === idField) properties.handle = handleProperty(type)
  }
  return { ...schema, properties }
}

/**
 * The success schema (`{ data, meta }`) with the `handle` property the
 * response layer stamps, so the spec and the runtime body agree. Returns
 * the schema unchanged when the declared position is not in it (the
 * coverage test fails on that).
 */
export function withHandleSchema(schema: JsonSchema, decl: HandleDeclaration | undefined): JsonSchema {
  if (!decl) return schema
  const data = schema.properties?.data
  if (!data) return schema
  const idField = decl.idField ?? 'id'
  let next: JsonSchema | undefined
  if (decl.at === undefined) {
    next = addHandleProperty(data, decl.type, idField)
  } else {
    const inner = addHandleProperty(data.properties?.[decl.at], decl.type, idField)
    next = inner ? { ...data, properties: { ...data.properties, [decl.at]: inner } } : undefined
  }
  if (!next) return schema
  return { ...schema, properties: { ...schema.properties, data: next } }
}

// ──────────────────────────────────────────────────────────────────
// Input: handles in the path, the query string and a JSON body
// ──────────────────────────────────────────────────────────────────

export type V1HandleInput =
  | {
      ok: true
      /** The request the handler gets: the original one unless a handle was replaced. */
      request: Request
      /** Route params with handles replaced. */
      params: Record<string, string | string[] | undefined>
      /** The pathname with handles replaced (the idempotency hash reads it). */
      path: string
      changed: boolean
    }
  | { ok: false; mismatches: HandleMismatch[] }

const NON_JSON_BODY_TYPES = ['multipart/', 'application/x-www-form-urlencoded', 'application/octet-stream'] as const

function contentType(request: Request): string {
  return (request.headers.get('content-type') ?? '').toLowerCase()
}

/**
 * Bodies read as JSON: v1 routes parse JSON whatever the Content-Type says
 * (body.ts), so only the shapes that are never JSON are skipped.
 */
function mayBeJsonBody(request: Request): boolean {
  const type = contentType(request)
  return !NON_JSON_BODY_TYPES.some((t) => type.includes(t))
}

/**
 * The text fields of a multipart body (documents.upload takes
 * journal_entry_id beside the file) with handles replaced: a new FormData
 * when one was, null when none was. File parts are carried over as they are.
 */
async function normalizeFormFields(request: Request, mismatches: HandleMismatch[]): Promise<FormData | null> {
  let form: FormData
  try {
    form = await request.clone().formData()
  } catch {
    // Not a readable form: the handler answers its own validation error.
    return null
  }
  let changed = false
  const next = new FormData()
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string') {
      next.append(key, value)
      continue
    }
    const r = normalizeQueryValue(key, value)
    if ('mismatches' in r) {
      mismatches.push(...r.mismatches)
      next.append(key, value)
      continue
    }
    changed ||= r.changed
    next.append(key, r.value)
  }
  return changed ? next : null
}

/**
 * Replace the handles in a v1 request with their UUIDs: the path (typed by
 * the collection segment before each parameter), the query string, a JSON
 * body and the text fields of a multipart body (typed by field name,
 * lib/handles/fields.ts). Other bodies are left alone.
 */
export async function normalizeV1Handles(
  request: Request,
  params: Record<string, string | string[] | undefined>,
): Promise<V1HandleInput> {
  const url = new URL(request.url)
  const mismatches: HandleMismatch[] = []

  const path = normalizeHandlePath(url.pathname)
  if (!path.ok) mismatches.push(...path.mismatches)
  const pathChanged = path.ok && path.changed

  let queryChanged = false
  const query = new URLSearchParams()
  for (const [key, value] of url.searchParams.entries()) {
    const r = normalizeQueryValue(key, value)
    if ('mismatches' in r) {
      mismatches.push(...r.mismatches)
      query.append(key, value)
      continue
    }
    queryChanged ||= r.changed
    query.append(key, r.value)
  }

  let bodyText: string | null = null
  let formBody: FormData | null = null
  if (request.body !== null && contentType(request).includes('multipart/form-data')) {
    formBody = await normalizeFormFields(request, mismatches)
  } else if (request.body !== null && mayBeJsonBody(request)) {
    const text = await request.clone().text()
    let parsed: unknown = undefined
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      // Not JSON after all: the handler answers its own validation error.
    }
    if (parsed !== undefined) {
      const r = normalizeHandleFields(parsed)
      if (!r.ok) mismatches.push(...r.mismatches)
      else if (r.changed) bodyText = JSON.stringify(r.value)
    }
  }

  if (mismatches.length > 0) return { ok: false, mismatches }

  const normalizedPath = path.ok ? path.value : url.pathname
  const normalizedParams = pathChanged ? normalizeParams(params) : params
  if (!pathChanged && !queryChanged && bodyText === null && formBody === null) {
    return { ok: true, request, params, path: url.pathname, changed: false }
  }

  const nextUrl = new URL(url)
  nextUrl.pathname = normalizedPath
  if (queryChanged) nextUrl.search = query.toString()
  const headers = new Headers(request.headers)
  let body: BodyInit | null = null
  if (bodyText !== null) {
    headers.delete('content-length')
    body = bodyText
  } else if (formBody !== null) {
    // A new form gets a new boundary: let the Request set its own header.
    headers.delete('content-length')
    headers.delete('content-type')
    body = formBody
  } else if (request.body !== null) {
    body = await request.clone().arrayBuffer()
  }
  const next = new Request(nextUrl, { method: request.method, headers, body, signal: request.signal })
  return { ok: true, request: next, params: normalizedParams, path: normalizedPath, changed: true }
}

/**
 * Route params with each handle value replaced by its UUID. The params are
 * the path's segments, which normalizeHandlePath already typed, so every
 * handle left here is one of the right type.
 */
function normalizeParams(
  params: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'string' ? (parseHandle(value)?.uuid ?? value) : value
  }
  return out
}

// ──────────────────────────────────────────────────────────────────
// Typed path ids that cannot be ids
// ──────────────────────────────────────────────────────────────────

/** A path id the request named that cannot name a row, in the v1 issues shape. */
export interface MalformedPathId {
  field: string
  message: string
}

/** How much of a refused value the issue echoes: enough to recognise it. */
const MAX_ECHOED_ID_LENGTH = 64

/**
 * The typed path parameters (pathParamTypes: `companies/:companyId`,
 * `invoices/:id`, ...) whose value is not a UUID once handles are read.
 * Every typed id names a uuid column, so such a value can never match a row,
 * and Postgres refuses it outright (22P02) wherever it reaches a filter.
 * `companyId` is typed even without a registered pattern: the wrapper's
 * company gate reads it on every route. Run on the params normalizeV1Handles
 * returned, so a handle of the right type is already its UUID here.
 */
export function malformedPathIds(
  pattern: string | undefined,
  params: Record<string, string | string[] | undefined>,
): MalformedPathId[] {
  const typing: Record<string, HandleType | null> = {
    ...(pattern ? pathParamTypes(pattern) : {}),
    companyId: 'company',
  }
  const issues: MalformedPathId[] = []
  for (const [field, type] of Object.entries(typing)) {
    const value = params[field]
    if (type === null || typeof value !== 'string' || UUID_RE.test(value)) continue
    const resource = handleResource(type)
    const shown = value.length > MAX_ECHOED_ID_LENGTH ? `${value.slice(0, MAX_ECHOED_ID_LENGTH)}...` : value
    issues.push({
      field,
      message:
        `${field} must be a ${resource.label} id: a UUID or a ${resource.prefix}_ handle. "${shown}" is neither.` +
        (field === 'companyId' ? ' GET /api/v1/companies lists the companies this key reaches.' : ''),
    })
  }
  return issues
}
