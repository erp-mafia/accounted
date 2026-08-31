/**
 * Integration tests for PATCH /api/v1/companies/:companyId/invoices/:id,
 * focused on the optional `items` full-replace path (metadata-only updates
 * keep their original behaviour and get a regression case here).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `invoice PATCH route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { eventBus } from '@/lib/events'
import { DELETE as deleteInvoice, PATCH as patchInvoice } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
type Capture = { table: string; op: 'update' | 'insert' | 'delete'; payload: unknown }

/**
 * Per-table result queues (arrays pop in order; single values repeat) plus a
 * capture log of update/insert payloads so totals recomputation is assertable.
 */
function makeFlexibleSupabase(
  byTable: Record<string, MockResult | MockResult[]>,
  captures: Capture[] = [],
) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        if (prop === 'update' || prop === 'insert') {
          return (payload: unknown) => {
            captures.push({ table, op: prop, payload })
            return buildChain(table)
          }
        }
        if (prop === 'delete') {
          return () => {
            captures.push({ table, op: 'delete', payload: undefined })
            return buildChain(table)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

const DRAFT_INVOICE = {
  id: INVOICE_ID,
  invoice_number: null,
  customer_id: CUSTOMER_ID,
  invoice_date: '2026-07-01',
  due_date: '2026-07-31',
  delivery_date: null,
  status: 'draft',
  currency: 'SEK',
  subtotal: 10000,
  vat_amount: 2500,
  total: 12500,
  vat_treatment: 'standard_25',
  document_type: 'invoice',
  your_reference: null,
  our_reference: null,
  notes: null,
  payment_link_url: null,
  payment_link_auto: true,
  default_dimensions: {},
  remaining_amount: 12500,
  created_at: '2026-07-01T09:00:00Z',
}

const INTERNAL_COLUMNS = {
  ore_rounding: null,
  deduction_personnummer_encrypted: null,
  deduction_personnummer_last4: null,
}

const NEW_ITEMS = [
  { description: 'Konsultation', quantity: 2, unit: 'tim', unit_price: 1000, vat_rate: 25 },
]

function makePatchRequest(body: unknown, opts: { idempotencyKey?: boolean; auth?: boolean; dryRun?: boolean } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.auth !== false) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  if (opts.idempotencyKey !== false) headers['Idempotency-Key'] = 'idem1234-7777-4abc-8def-1234567890ab'
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}${opts.dryRun ? '?dry_run=true' : ''}`
  return new Request(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:write'],
    mode: 'live',
  })
})

describe('PATCH /api/v1/companies/:companyId/invoices/:id', () => {
  it('returns 401 without a bearer token', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await patchInvoice(
      makePatchRequest({ notes: 'x' }, { auth: false }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 400 VALIDATION_ERROR for an empty items array', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await patchInvoice(
      makePatchRequest({ items: [] }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 when the invoice does not belong to the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }),
    )

    const res = await patchInvoice(
      makePatchRequest({ items: NEW_ITEMS }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 409 INVOICE_UPDATE_NOT_DRAFT when replacing items on a sent invoice', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...DRAFT_INVOICE, status: 'sent', invoice_number: '2026-0042' }, error: null },
      }),
    )

    const res = await patchInvoice(
      makePatchRequest({ items: NEW_ITEMS }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_UPDATE_NOT_DRAFT')
    expect(body.error.details.current_status).toBe('sent')
  })

  it('replaces the items and recomputes totals against the existing customer', async () => {
    const captures: Capture[] = []
    const COMPLETE = {
      ...DRAFT_INVOICE,
      subtotal: 2000,
      vat_amount: 500,
      total: 2500,
      items: [
        {
          id: 'iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii',
          sort_order: 0,
          description: 'Konsultation',
          quantity: 2,
          unit: 'tim',
          unit_price: 1000,
          line_total: 2000,
          vat_rate: 25,
          vat_amount: 500,
        },
      ],
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: [
            { data: DRAFT_INVOICE, error: null }, // pre-flight
            { data: INTERNAL_COLUMNS, error: null }, // internal-only columns
            { data: { ...DRAFT_INVOICE, subtotal: 2000, vat_amount: 500, total: 2500 }, error: null }, // update
            { data: COMPLETE, error: null }, // refetch with items
          ],
          customers: {
            data: { id: CUSTOMER_ID, customer_type: 'swedish_business', vat_number_validated: true },
            error: null,
          },
          company_settings: { data: { vat_registered: true }, error: null },
          invoice_items: { data: null, error: null },
        },
        captures,
      ),
    )

    const res = await patchInvoice(
      makePatchRequest({ items: NEW_ITEMS }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.total).toBe(2500)
    expect(body.data.items).toHaveLength(1)

    // The update payload carries recomputed money math (2 x 1000 + 25% VAT)
    // built against the EXISTING customer_id.
    const invoiceUpdate = captures.find((c) => c.table === 'invoices' && c.op === 'update')
    expect(invoiceUpdate).toBeDefined()
    expect(invoiceUpdate!.payload).toMatchObject({
      customer_id: CUSTOMER_ID,
      subtotal: 2000,
      vat_amount: 500,
      total: 2500,
    })

    // Full replace: one insert with the new line set, invoice_id stamped on.
    const itemsInsert = captures.find((c) => c.table === 'invoice_items' && c.op === 'insert')
    expect(itemsInsert).toBeDefined()
    expect(itemsInsert!.payload).toEqual([
      expect.objectContaining({
        invoice_id: INVOICE_ID,
        description: 'Konsultation',
        line_total: 2000,
        vat_amount: 500,
      }),
    ])
  })

  it('dry-run previews the replaced items without writing', async () => {
    const captures: Capture[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: [
            { data: DRAFT_INVOICE, error: null },
            { data: INTERNAL_COLUMNS, error: null },
          ],
          customers: {
            data: { id: CUSTOMER_ID, customer_type: 'swedish_business', vat_number_validated: true },
            error: null,
          },
          company_settings: { data: { vat_registered: true }, error: null },
        },
        captures,
      ),
    )

    const res = await patchInvoice(
      makePatchRequest({ items: NEW_ITEMS }, { dryRun: true }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.total).toBe(2500)
    expect(body.data.preview.items).toHaveLength(1)
    // The encrypted personnummer blob never appears in a preview.
    expect(body.data.preview).not.toHaveProperty('deduction_personnummer_encrypted')
    // No writes happened.
    expect(captures).toEqual([])
  })

  it('still performs a metadata-only update when items are omitted', async () => {
    const captures: Capture[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: [
            { data: DRAFT_INVOICE, error: null },
            { data: { ...DRAFT_INVOICE, due_date: '2026-08-15' }, error: null },
          ],
        },
        captures,
      ),
    )

    const res = await patchInvoice(
      makePatchRequest({ due_date: '2026-08-15' }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.due_date).toBe('2026-08-15')
    // No items were touched.
    expect(captures.filter((c) => c.table === 'invoice_items')).toEqual([])
  })

  it('rejects a write without an Idempotency-Key', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await patchInvoice(
      makePatchRequest({ items: NEW_ITEMS }, { idempotencyKey: false }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

function makeDeleteRequest(opts: { idempotencyKey?: boolean; auth?: boolean; dryRun?: boolean; id?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.auth !== false) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  if (opts.idempotencyKey !== false) headers['Idempotency-Key'] = 'idemdele-7777-4abc-8def-1234567890ab'
  const id = opts.id ?? INVOICE_ID
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${id}${opts.dryRun ? '?dry_run=true' : ''}`
  return new Request(url, { method: 'DELETE', headers })
}

describe('DELETE /api/v1/companies/:companyId/invoices/:id', () => {
  it('returns 401 without a bearer token', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await deleteInvoice(
      makeDeleteRequest({ auth: false }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 400 VALIDATION_ERROR for a non-UUID id', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await deleteInvoice(
      makeDeleteRequest({ id: 'not-a-uuid' }),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a delete without an Idempotency-Key', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await deleteInvoice(
      makeDeleteRequest({ idempotencyKey: false }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 when the invoice does not belong to the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // deleteDraftInvoice fetches via .single(): a foreign or nonexistent
        // id surfaces as an error result.
        invoices: { data: null, error: { message: 'Row not found' } },
      }),
    )

    const res = await deleteInvoice(makeDeleteRequest(), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 409 INVOICE_DELETE_NOT_DRAFT for a sent invoice', async () => {
    const captures: Capture[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: {
            data: { ...DRAFT_INVOICE, status: 'sent', invoice_number: '2026-0042' },
            error: null,
          },
        },
        captures,
      ),
    )

    const res = await deleteInvoice(makeDeleteRequest(), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_DELETE_NOT_DRAFT')
    expect(body.error.details.current_status).toBe('sent')
    // Nothing was written to the invoice.
    expect(captures.filter((c) => c.table === 'invoices')).toEqual([])
  })

  it('hard deletes an unnumbered draft and emits the audit event', async () => {
    const captures: Capture[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: [
            { data: DRAFT_INVOICE, error: null }, // fetch: draft, invoice_number null
            { data: [{ id: INVOICE_ID }], error: null }, // delete().select('id')
          ],
        },
        captures,
      ),
    )
    const emitSpy = vi.spyOn(eventBus, 'emit')

    const res = await deleteInvoice(makeDeleteRequest(), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.deleted).toBe(true)
    // The event-log handler may add its own event_log insert via the same
    // mocked service client: scope the assertion to the invoices table.
    expect(captures.filter((c) => c.table === 'invoices')).toEqual([
      { table: 'invoices', op: 'delete', payload: undefined },
    ])
    // The hard delete leaves no journal trace: the audit event must carry the
    // EXPLICIT actor from the API-key context (auth.uid() is null here).
    expect(emitSpy).toHaveBeenCalledWith({
      type: 'invoice.draft_deleted',
      payload: { invoiceId: INVOICE_ID, companyId: COMPANY_ID, userId: USER_ID },
    })
  })

  it('cancels a numbered draft, retaining the F-series number', async () => {
    const captures: Capture[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: [
            { data: { ...DRAFT_INVOICE, invoice_number: '2026-0042' }, error: null }, // fetch
            { data: [{ id: INVOICE_ID }], error: null }, // update().select('id')
          ],
        },
        captures,
      ),
    )

    const res = await deleteInvoice(makeDeleteRequest(), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.cancelled).toBe(true)
    expect(body.data.invoice_number).toBe('2026-0042')
    // The row survives as makulerad: an update, never a delete.
    const update = captures.find((c) => c.table === 'invoices' && c.op === 'update')
    expect(update).toBeDefined()
    expect(update!.payload).toMatchObject({ status: 'cancelled' })
    expect(captures.filter((c) => c.op === 'delete')).toEqual([])
  })

  it('returns 409 INVOICE_CANCEL_RACE when the draft is finalized concurrently', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: DRAFT_INVOICE, error: null }, // fetch: unnumbered draft
          { data: [], error: null }, // delete matched 0 rows: finalized meanwhile
        ],
      }),
    )

    const res = await deleteInvoice(makeDeleteRequest(), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CANCEL_RACE')
  })

  it('dry-run previews the outcome without writing', async () => {
    const captures: Capture[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: { data: { ...DRAFT_INVOICE, invoice_number: '2026-0042' }, error: null },
        },
        captures,
      ),
    )

    const res = await deleteInvoice(
      makeDeleteRequest({ dryRun: true }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toEqual({ cancelled: true, invoice_number: '2026-0042' })
    expect(captures.filter((c) => c.table === 'invoices')).toEqual([])
  })
})
