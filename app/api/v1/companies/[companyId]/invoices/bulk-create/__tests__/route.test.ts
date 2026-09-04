/**
 * Integration tests for POST /api/v1/companies/:companyId/invoices/bulk-create.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `bulk-create route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
vi.mock('@/lib/currency/riksbanken', async () => {
  const actual = await vi.importActual<typeof import('@/lib/currency/riksbanken')>('@/lib/currency/riksbanken')
  return { ...actual, fetchExchangeRate: vi.fn().mockResolvedValue(null) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as bulkCreate } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
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
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

function makeRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-4040-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}
function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

const VALID_CUSTOMER = {
  id: CUSTOMER_ID,
  customer_type: 'swedish_business',
  vat_number_validated: true,
}

const SAMPLE_ITEM = (description = 'A') => ({
  description,
  quantity: 1,
  unit: 'st',
  unit_price: 1000,
})

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

describe('POST /api/v1/companies/:companyId/invoices/bulk-create', () => {
  it('creates two invoices and returns a partial-success summary', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: VALID_CUSTOMER, error: null },
        invoices: [
          { data: { id: 'inv-1', invoice_number: null, status: 'draft', total: 1250 }, error: null },
          { data: { id: 'inv-2', invoice_number: null, status: 'draft', total: 1250 }, error: null },
        ],
        invoice_items: { data: null, error: null },
      }),
    )

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create`, {
        invoices: [
          {
            customer_id: CUSTOMER_ID,
            invoice_date: '2026-05-12',
            due_date: '2026-06-11',
            currency: 'SEK',
            items: [SAMPLE_ITEM('A')],
          },
          {
            customer_id: CUSTOMER_ID,
            invoice_date: '2026-05-12',
            due_date: '2026-06-11',
            currency: 'SEK',
            items: [SAMPLE_ITEM('B')],
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.summary.total).toBe(2)
    expect(body.data.summary.succeeded).toBe(2)
    expect(body.data.summary.failed).toBe(0)
    expect(body.data.results[0].ok).toBe(true)
    expect(body.data.results[0].request_index).toBe(0)
    expect(body.data.results[1].ok).toBe(true)
  })

  it('returns per-item failure when customer not found', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: null, error: null }, // not found for every fetch
      }),
    )

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create`, {
        invoices: [
          {
            customer_id: CUSTOMER_ID,
            invoice_date: '2026-05-12',
            due_date: '2026-06-11',
            currency: 'SEK',
            items: [SAMPLE_ITEM('A')],
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results[0].ok).toBe(false)
    expect(body.data.results[0].error.code).toBe('INVOICE_CUSTOMER_NOT_FOUND')
    expect(body.data.summary.failed).toBe(1)
    expect(body.data.summary.succeeded).toBe(0)
  })

  // A quote needs its own OF-number, valid_until and quote_status, none of
  // which the bulk path assigns, so the item is refused before any DB access
  // and the sibling invoice in the same batch still succeeds.
  it('refuses a quote item per item without inserting, other items unaffected', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      customers: { data: VALID_CUSTOMER, error: null },
      invoices: { data: { id: 'inv-1', invoice_number: null, status: 'draft', total: 1250 }, error: null },
      invoice_items: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create`, {
        invoices: [
          {
            customer_id: CUSTOMER_ID,
            document_type: 'quote',
            invoice_date: '2026-09-02',
            due_date: '2026-10-02',
            valid_until: '2026-10-02',
            currency: 'SEK',
            items: [SAMPLE_ITEM('Offert')],
          },
          {
            customer_id: CUSTOMER_ID,
            invoice_date: '2026-09-02',
            due_date: '2026-10-02',
            currency: 'SEK',
            items: [SAMPLE_ITEM('B')],
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results[0].ok).toBe(false)
    expect(body.data.results[0].request_index).toBe(0)
    expect(body.data.results[0].error.code).toBe('VALIDATION_ERROR')
    expect(body.data.results[0].error.details).toEqual({
      field: 'document_type',
      message: 'Quotes are not supported by bulk-create; use POST /invoices with document_type quote.',
    })
    expect(body.data.results[1].ok).toBe(true)
    expect(body.data.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })

    // Only the invoice item touched the customers and invoices tables.
    const tables = supabase.from.mock.calls.map((c) => c[0])
    expect(tables.filter((t) => t === 'customers')).toHaveLength(1)
    expect(tables.filter((t) => t === 'invoices')).toHaveLength(1)
  })

  // A validated EU business: the picker default is 0% (huvudregeln, ML 6 kap.
  // 34 §), but the ML 6 kap. supplies taxed where they are performed carry
  // Swedish VAT to that same customer, so the gate reads getPermittedVatRates.
  const EU_CUSTOMER = {
    id: CUSTOMER_ID,
    customer_type: 'eu_business',
    vat_number_validated: true,
  }

  it('accepts a 12% line to a validated EU business (taxed where performed)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: EU_CUSTOMER, error: null },
        invoices: { data: { id: 'inv-1', invoice_number: null, status: 'draft', total: 1120 }, error: null },
        invoice_items: { data: null, error: null },
      }),
    )

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create`, {
        invoices: [
          {
            customer_id: CUSTOMER_ID,
            invoice_date: '2026-05-12',
            due_date: '2026-06-11',
            currency: 'SEK',
            items: [{ ...SAMPLE_ITEM('Hotellnatt Stockholm'), vat_rate: 12 }],
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results[0].ok).toBe(true)
    expect(body.data.summary.succeeded).toBe(1)
  })

  it('still rejects a non-Swedish rate for a validated EU business', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: EU_CUSTOMER, error: null },
      }),
    )

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create`, {
        invoices: [
          {
            customer_id: CUSTOMER_ID,
            invoice_date: '2026-05-12',
            due_date: '2026-06-11',
            currency: 'SEK',
            items: [{ ...SAMPLE_ITEM('A'), vat_rate: 10 }],
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results[0].ok).toBe(false)
    expect(body.data.results[0].error.code).toBe('INVOICE_CREATE_VAT_RULE_VIOLATION')
    expect(body.data.results[0].error.details.allowed_rates).toEqual([0, 25, 12, 6])
  })

  it('returns 400 VALIDATION_ERROR when the bulk envelope is malformed', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create`, {
        invoices: [], // min(1) violation
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects more than 50 invoices in one request', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const invoices = Array.from({ length: 51 }, () => ({
      customer_id: CUSTOMER_ID,
      invoice_date: '2026-05-12',
      due_date: '2026-06-11',
      currency: 'SEK',
      items: [SAMPLE_ITEM('A')],
    }))

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create`, {
        invoices,
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('dry-run returns previews without inserting', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      customers: { data: VALID_CUSTOMER, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create?dry_run=true`, {
        invoices: [
          {
            customer_id: CUSTOMER_ID,
            invoice_date: '2026-05-12',
            due_date: '2026-06-11',
            currency: 'SEK',
            items: [SAMPLE_ITEM('A')],
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.summary.succeeded).toBe(1)
    expect(body.data.preview.results[0].ok).toBe(true)
    expect(body.data.preview.results[0].data.preview.total).toBe(1250)
    // No `invoices` insert was called.
    const insertedInvoice = supabaseMock.from.mock.calls.some((c) => c[0] === 'invoices')
    expect(insertedInvoice).toBe(false)
  })

  it('forces every line to 0% when the company is not VAT registered (issue #1719)', async () => {
    // Momskrysset off (company_settings.vat_registered = false): the invoice
    // must come out momsfri whether the payload sends an explicit rate or
    // relies on the customer-default fallback (25% for a Swedish customer).
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: VALID_CUSTOMER, error: null },
        company_settings: { data: { vat_registered: false }, error: null },
      }),
    )

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create?dry_run=true`, {
        invoices: [
          {
            customer_id: CUSTOMER_ID,
            invoice_date: '2026-05-12',
            due_date: '2026-06-11',
            currency: 'SEK',
            items: [
              { ...SAMPLE_ITEM('Explicit 25'), vat_rate: 25 },
              SAMPLE_ITEM('Fallback rate'),
            ],
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview.summary.succeeded).toBe(1)
    const preview = body.data.preview.results[0].data.preview
    expect(preview.subtotal).toBe(2000)
    expect(preview.vat_amount).toBe(0)
    expect(preview.total).toBe(2000)
    for (const item of preview.items) {
      expect(item.vat_rate).toBe(0)
      expect(item.vat_amount).toBe(0)
    }
  })

  it('rejects all_or_nothing: true with 501 NOT_IMPLEMENTED', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create`, {
        all_or_nothing: true,
        invoices: [
          {
            customer_id: CUSTOMER_ID,
            invoice_date: '2026-05-12',
            due_date: '2026-06-11',
            currency: 'SEK',
            items: [SAMPLE_ITEM('A')],
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(501)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_IMPLEMENTED')
  })

  it('rejects keys without invoices:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create`, {
        invoices: [
          {
            customer_id: CUSTOMER_ID,
            invoice_date: '2026-05-12',
            due_date: '2026-06-11',
            currency: 'SEK',
            items: [SAMPLE_ITEM('A')],
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(403)
  })
})
