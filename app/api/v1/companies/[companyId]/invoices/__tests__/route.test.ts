/**
 * Integration tests for GET /api/v1/companies/:companyId/invoices and
 * /api/v1/companies/:companyId/invoices/:id.
 *
 * Mocks validateApiKey + the service-role Supabase client. The mock supports
 * per-table results so the wrapper's `company_members` membership check and
 * the handler's `invoices` query both resolve correctly in the same call.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `invoices route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

// Stub the F-series allocator so tests don't depend on the
// generate_invoice_number Postgres RPC. The route's flow is what we're
// testing, not the allocator itself (which has its own pg-real tests).
vi.mock('@/lib/invoices/ensure-invoice-number', () => ({
  ensureInvoiceNumber: vi.fn().mockResolvedValue(undefined),
}))

// Riksbanken exchange-rate fetcher: return null by default (treats as
// SEK-only). Individual tests can override.
vi.mock('@/lib/currency/riksbanken', async () => {
  const actual = await vi.importActual<typeof import('@/lib/currency/riksbanken')>('@/lib/currency/riksbanken')
  return {
    ...actual,
    fetchExchangeRate: vi.fn().mockResolvedValue(null),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listInvoices, POST as createInvoice } from '../route'
import { GET as getInvoice, PATCH as updateInvoice } from '../[id]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

/**
 * Build a Supabase client mock keyed by table name. Every chained method
 * call returns a proxy that resolves to byTable[table] when awaited.
 */
function makeFlexibleSupabase(byTable: Record<string, { data?: unknown; error?: unknown }>) {
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(byTable[table] ?? { data: null, error: null })
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

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key', ...(init?.headers ?? {}) },
  })
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
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
    scopes: ['invoices:read'],
    mode: 'live',
  })
})

const SAMPLE_INVOICE = {
  id: INVOICE_ID,
  invoice_number: '2026-0042',
  customer_id: CUSTOMER_ID,
  invoice_date: '2026-05-01',
  due_date: '2026-05-31',
  status: 'sent',
  document_type: 'invoice',
  currency: 'SEK',
  subtotal: 10000,
  vat_amount: 2500,
  total: 12500,
  remaining_amount: 12500,
  paid_at: null,
  created_at: '2026-05-01T09:14:33Z',
  customer: { id: CUSTOMER_ID, name: 'Acme AB' },
}

describe('GET /api/v1/companies/:companyId/invoices', () => {
  it('returns a paginated invoice list with inline customer_name', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: [SAMPLE_INVOICE], error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].customer_name).toBe('Acme AB')
    expect(body.data[0].invoice_number).toBe('2026-0042')
    // Default response shape MUST NOT include the full customer object.
    expect(body.data[0].customer).toBeUndefined()
    expect(body.meta.request_id).toMatch(/^req_/)
  })

  it('embeds the full customer when ?expand=customer is requested', async () => {
    const sampleWithFullCustomer = {
      ...SAMPLE_INVOICE,
      customer: {
        id: CUSTOMER_ID,
        name: 'Acme AB',
        email: 'a@acme.test',
        country: 'Sweden',
      },
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: [sampleWithFullCustomer], error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?expand=customer`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data[0].customer).toEqual(sampleWithFullCustomer.customer)
  })

  it('rejects unknown ?expand values with VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?expand=bogus`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.invalidKeys).toEqual(['bogus'])
  })

  it('rejects an invalid currency filter (not ISO-4217)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?currency=sek`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('accepts a valid ISO-4217 currency code', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: [SAMPLE_INVOICE], error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?currency=SEK`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
  })

  it('rejects an invalid status filter', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?status=quantum`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('emits a next_cursor when the page is full', async () => {
    const overFetched = [
      SAMPLE_INVOICE,
      { ...SAMPLE_INVOICE, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    ]
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: overFetched, error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?limit=1`),
      companyParams(COMPANY_ID),
    )

    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.meta.next_cursor).toBeTruthy()
  })
})

describe('GET /api/v1/companies/:companyId/invoices/:id', () => {
  it('returns the invoice with the embedded customer', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: SAMPLE_INVOICE, error: null },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(INVOICE_ID)
    expect(body.data.customer.name).toBe('Acme AB')
  })

  it('returns 404 when the invoice does not exist for the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('rejects unknown ?expand values', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}?expand=foo`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 VALIDATION_ERROR when :id is not a UUID', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/not-a-uuid`),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('id')
  })

  it('does not echo the queried id on 404 (enumeration hardening)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.details).toEqual({ resource: 'invoice' })
    expect(body.error.details.id).toBeUndefined()
  })
})

describe('scope enforcement', () => {
  it('returns 403 INSUFFICIENT_SCOPE when key lacks invoices:read', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['customers:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('returns 404 when the URL companyId is not one the key user belongs to', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: null, error: null }, // no membership
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

// ──────────────────────────────────────────────────────────────────
// POST /api/v1/companies/:companyId/invoices
// ──────────────────────────────────────────────────────────────────

function withInvoiceWriteScope() {
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:write'],
    mode: 'live',
  })
}

function makePostInvoice(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-5555-4abc-8def-1234567890ab',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
}

function makePatchInvoice(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-6666-4abc-8def-1234567890ab',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
}

// A swedish_business customer with VAT validated: picks up 25% as the
// only allowed rate (vat_treatment: standard_25). Reduced rates (12 / 6)
// would need a wider VAT-rule fixture; SEK + standard 25% is enough for
// the route-level tests here.
const SWEDISH_BUSINESS_CUSTOMER = {
  id: CUSTOMER_ID,
  customer_type: 'swedish_business',
  vat_number_validated: true,
}

describe('POST /api/v1/companies/:companyId/invoices', () => {
  it('creates a draft invoice with computed totals', async () => {
    withInvoiceWriteScope()
    const createdInvoice = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      invoice_number: null,
      customer_id: CUSTOMER_ID,
      invoice_date: '2026-05-12',
      due_date: '2026-06-11',
      status: 'draft',
      currency: 'SEK',
      subtotal: 10000,
      vat_amount: 2500,
      total: 12500,
      remaining_amount: 12500,
      document_type: 'invoice',
      created_at: '2026-05-12T16:00:00Z',
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: SWEDISH_BUSINESS_CUSTOMER, error: null },
        invoices: { data: createdInvoice, error: null },
        invoice_items: { data: null, error: null },
      }),
    )

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [{ description: 'Konsultation', quantity: 8, unit: 'tim', unit_price: 1250 }],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.customer_id).toBe(CUSTOMER_ID)
    expect(body.data.total).toBe(12500)
  })

  it('returns 404 INVOICE_CUSTOMER_NOT_FOUND when customer does not belong to company', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: null, error: null }, // No match
      }),
    )

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [{ description: 'x', quantity: 1, unit: 'st', unit_price: 100 }],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CUSTOMER_NOT_FOUND')
  })

  it('rejects a per-item vat_rate not allowed for the customer', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: SWEDISH_BUSINESS_CUSTOMER, error: null },
      }),
    )

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        // 17 % is not a valid Swedish VAT rate.
        items: [{ description: 'x', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 17 }],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREATE_VAT_RULE_VIOLATION')
    expect(body.error.details.attempted_rate).toBe(17)
    expect(Array.isArray(body.error.details.allowed_rates)).toBe(true)
  })

  it('dry-run returns 200 + X-Dry-Run + preview with computed totals; no DB writes', async () => {
    withInvoiceWriteScope()
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      customers: { data: SWEDISH_BUSINESS_CUSTOMER, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?dry_run=true`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [
          { description: 'A', quantity: 2, unit: 'st', unit_price: 500 },
          { description: 'B', quantity: 1, unit: 'st', unit_price: 1000 },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    // Preview: subtotal=2000, vat=500 (25%), total=2500.
    expect(body.data.preview.subtotal).toBe(2000)
    expect(body.data.preview.vat_amount).toBe(500)
    expect(body.data.preview.total).toBe(2500)
    expect(body.data.preview.items).toHaveLength(2)
    // No insert into `invoices` happened.
    const insertedInvoice = supabaseMock.from.mock.calls.some((c) => c[0] === 'invoices')
    expect(insertedInvoice).toBe(false)
  })

  it('rejects keys without invoices:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [{ description: 'x', quantity: 1, unit: 'st', unit_price: 100 }],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('rejects requests without Idempotency-Key', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const req = new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [{ description: 'x', quantity: 1, unit: 'st', unit_price: 100 }],
      }),
    })

    const res = await createInvoice(req, companyParams(COMPANY_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

// ──────────────────────────────────────────────────────────────────
// PATCH /api/v1/companies/:companyId/invoices/:id
// ──────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/companies/:companyId/invoices/:id', () => {
  it('updates allowed metadata fields on a draft invoice', async () => {
    withInvoiceWriteScope()
    const draftInvoice = {
      id: INVOICE_ID,
      status: 'draft',
      invoice_date: '2026-05-12',
      due_date: '2026-06-11',
      notes: 'old note',
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: {
          data: { ...draftInvoice, due_date: '2026-07-15', notes: 'Förlängd' },
          error: null,
        },
      }),
    )

    const res = await updateInvoice(
      makePatchInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`, {
        due_date: '2026-07-15',
        notes: 'Förlängd',
      }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.due_date).toBe('2026-07-15')
    expect(body.data.notes).toBe('Förlängd')
  })

  it('returns 409 INVOICE_UPDATE_NOT_DRAFT for non-draft invoices', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { id: INVOICE_ID, status: 'sent' }, error: null },
      }),
    )

    const res = await updateInvoice(
      makePatchInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`, {
        notes: 'will be rejected',
      }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_UPDATE_NOT_DRAFT')
    expect(body.error.details.current_status).toBe('sent')
  })

  it('rejects an empty body', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateInvoice(
      makePatchInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`, {}),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 VALIDATION_ERROR when :id is not a UUID', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateInvoice(
      makePatchInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/not-a-uuid`, {
        notes: 'x',
      }),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
  })

  it('dry-run merges current + proposed changes without committing', async () => {
    withInvoiceWriteScope()
    const draftInvoice = {
      id: INVOICE_ID,
      status: 'draft',
      invoice_date: '2026-05-12',
      due_date: '2026-06-11',
      notes: null,
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: draftInvoice, error: null },
      }),
    )

    const res = await updateInvoice(
      makePatchInvoice(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}?dry_run=true`,
        { notes: 'preview' },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview.notes).toBe('preview')
    expect(body.data.preview.due_date).toBe('2026-06-11') // unchanged from current
  })

  it('rejects forbidden fields (items / currency / customer_id)', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateInvoice(
      makePatchInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`, {
        customer_id: CUSTOMER_ID,
        currency: 'EUR',
        items: [{ description: 'no', quantity: 1, unit: 'st', unit_price: 1 }],
      }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    // The forbidden fields are stripped by Zod; the resulting body is `{}`
    // which fails the "at least one field" guard.
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})
