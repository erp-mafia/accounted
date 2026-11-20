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

type InsertCapture = { table: string; payload: unknown }

/**
 * Keep only the columns a flat select() asked for, as PostgREST would.
 * '*' (or no select at all) returns the row untouched.
 */
function projectRow(data: unknown, columns: string | null): unknown {
  if (!columns || columns.trim() === '*') return data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data
  const row = data as Record<string, unknown>
  const wanted = columns.split(',').map((column) => column.trim()).filter(Boolean)
  return Object.fromEntries(wanted.filter((column) => column in row).map((column) => [column, row[column]]))
}

/**
 * Build a Supabase client mock keyed by table name. Every chained method
 * call returns a proxy that resolves to byTable[table] when awaited.
 *
 * The `customers` chain honours select(): the resolved row carries only the
 * requested columns. It used to hand back the whole fixture whatever was
 * selected, so a route that forgot a column the VAT rule reads still saw it
 * and the test passed on broken code. That is how #2783 hid: `country` was
 * never selected, and an SE-country test written against the old mock was
 * green before the fix. Insert payloads are recorded when `inserts` is given.
 */
function makeFlexibleSupabase(
  byTable: Record<string, { data?: unknown; error?: unknown }>,
  inserts: InsertCapture[] = [],
  filters: Array<{ table: string; method: string; args: unknown[] }> = [],
  selects: Array<{ table: string; columns: string }> = [],
) {
  const buildChain = (table: string, columns: string | null): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            // The read of the invoices' own payment reference facts
            // (withPaymentReference) is a second read of `invoices`: it gets
            // its own answer, `invoice_reference_facts`, and no rows when a
            // test names none.
            if (table === 'invoices' && columns?.includes('autogiro_payer_number')) {
              resolve(byTable.invoice_reference_facts ?? { data: [], error: null })
              return
            }
            const result = byTable[table] ?? { data: null, error: null }
            resolve(table === 'customers' ? { ...result, data: projectRow(result.data, columns) } : result)
          }
        }
        if (prop === 'select') {
          return (requested?: unknown) => {
            if (typeof requested === 'string') selects.push({ table, columns: requested })
            return buildChain(table, typeof requested === 'string' ? requested : columns)
          }
        }
        if (prop === 'insert') {
          return (payload: unknown) => {
            inserts.push({ table, payload })
            return buildChain(table, columns)
          }
        }
        return (...args: unknown[]) => {
          filters.push({ table, method: String(prop), args })
          return buildChain(table, columns)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table, null)) }
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

  // crm#1487: what each invoice asks for, from its own rounding choice; the
  // company setting decides only a draft that has none.
  it('returns amount_to_pay and ore_rounding_amount on every row', async () => {
    const selects: Array<{ table: string; columns: string }> = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: {
            data: [
              { ...SAMPLE_INVOICE, total: 4.38, ore_rounding: false, deduction_total: 0, credited_invoice_id: null },
              { ...SAMPLE_INVOICE, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', total: -4.38, ore_rounding: true, deduction_total: 0, credited_invoice_id: INVOICE_ID },
              { ...SAMPLE_INVOICE, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', status: 'draft', total: 4.38, ore_rounding: null, deduction_total: 0, credited_invoice_id: null },
            ],
            error: null,
          },
          company_settings: { data: { ore_rounding: true }, error: null },
        },
        [],
        [],
        selects,
      ),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((r: { amount_to_pay: number }) => r.amount_to_pay)).toEqual([4.38, -4, 4])
    expect(body.data.map((r: { ore_rounding_amount: number }) => r.ore_rounding_amount)).toEqual([0, 0.38, -0.38])
    // Read for the computation only, never returned.
    expect(body.data[0].ore_rounding).toBeUndefined()
    expect(body.data[0].deduction_total).toBeUndefined()
    const invoiceSelect = selects.find((s) => s.table === 'invoices')!.columns
    expect(invoiceSelect).toContain('ore_rounding')
    expect(invoiceSelect).toContain('deduction_total')
  })

  // crm#1367: a received self-billed sale has invoice_number null by design;
  // without the customer's number it listed like an unsent draft.
  it('returns external_invoice_number and is_self_billed on every row', async () => {
    const selects: Array<{ table: string; columns: string }> = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: {
            data: [
              { ...SAMPLE_INVOICE, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', invoice_number: null, external_invoice_number: 'S2441', is_self_billed: true, status: 'paid', remaining_amount: 0 },
              SAMPLE_INVOICE,
            ],
            error: null,
          },
        },
        [],
        [],
        selects,
      ),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    const invoiceSelect = selects.find((s) => s.table === 'invoices')?.columns ?? ''
    expect(invoiceSelect).toContain('external_invoice_number')
    expect(invoiceSelect).toContain('is_self_billed')
    expect(body.data[0]).toMatchObject({ invoice_number: null, external_invoice_number: 'S2441', is_self_billed: true })
    expect(body.data[1]).toMatchObject({ invoice_number: '2026-0042', external_invoice_number: null, is_self_billed: false })
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

  it('reports a sent invoice past its due date as overdue and one not yet due as sent (crm#1084)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: {
          data: [
            SAMPLE_INVOICE,
            { ...SAMPLE_INVOICE, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', due_date: '2099-12-31' },
            { ...SAMPLE_INVOICE, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', status: 'partially_paid', remaining_amount: 100 },
          ],
          error: null,
        },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?limit=10`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((row: { status: string }) => row.status)).toEqual(['overdue', 'sent', 'partially_paid'])
    // credited_invoice_id is read by the rule, never returned.
    expect(body.data[0].credited_invoice_id).toBeUndefined()
  })

  it('?status=overdue filters on the due date and the open remainder, not the stored status', async () => {
    const filters: Array<{ table: string; method: string; args: unknown[] }> = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: { data: [SAMPLE_INVOICE], error: null },
        },
        [],
        filters,
      ),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?status=overdue`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const invoiceFilters = filters.filter((f) => f.table === 'invoices').map((f) => [f.method, ...f.args])
    expect(invoiceFilters).toContainEqual(['in', 'status', ['sent', 'overdue', 'partially_paid']])
    expect(invoiceFilters).toContainEqual(['eq', 'document_type', 'invoice'])
    expect(invoiceFilters).toContainEqual(['is', 'credited_invoice_id', null])
    expect(invoiceFilters).toContainEqual(['gt', 'remaining_amount', 0])
    expect(invoiceFilters.some((f) => f[0] === 'lt' && f[1] === 'due_date')).toBe(true)
    expect(invoiceFilters).not.toContainEqual(['eq', 'status', 'overdue'])
    const body = await res.json()
    expect(body.data[0].status).toBe('overdue')
  })

  it('?status=sent leaves out invoices that are overdue by date', async () => {
    const filters: Array<{ table: string; method: string; args: unknown[] }> = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          invoices: { data: [], error: null },
        },
        [],
        filters,
      ),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?status=sent`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const invoiceFilters = filters.filter((f) => f.table === 'invoices').map((f) => [f.method, ...f.args])
    expect(invoiceFilters).toContainEqual(['in', 'status', ['sent', 'overdue']])
    const or = invoiceFilters.find((f) => f[0] === 'or')
    expect(String(or?.[1])).toMatch(/^document_type\.neq\.invoice,credited_invoice_id\.not\.is\.null,total\.lt\.0,due_date\.gte\.\d{4}-\d{2}-\d{2},remaining_amount\.lte\.0$/)
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

// crm#1886: the reference the invoice PDF prints was returned by no door, so
// an integrator who delivers the invoice itself had to rebuild the check digit.
describe('GET invoices: payment_reference (crm#1886)', () => {
  const DRAFT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const facts = (overrides: Record<string, unknown> = {}) => ({
    id: INVOICE_ID,
    payment_details: null,
    autogiro_payer_number: null,
    customer: { language: 'sv' },
    ...overrides,
  })
  const supabaseWith = (tables: Record<string, { data?: unknown; error?: unknown }>) =>
    makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      ...tables,
    })

  it('lists each invoice with the reference its PDF prints, null on a draft', async () => {
    mockServiceClient.mockReturnValue(
      supabaseWith({
        invoices: {
          data: [SAMPLE_INVOICE, { ...SAMPLE_INVOICE, id: DRAFT_ID, status: 'draft', invoice_number: null }],
          error: null,
        },
        company_settings: { data: { bankgiro: '5050-1055' }, error: null },
        invoice_reference_facts: { data: [facts()], error: null },
      }),
    )

    const res = await listInvoices(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    // 2026-0042: its digits and a Luhn check digit.
    expect(body.data[0]).toMatchObject({ id: INVOICE_ID, payment_reference: '202600425', payment_reference_type: 'ocr' })
    expect(body.data[1]).toMatchObject({ id: DRAFT_ID, payment_reference: null, payment_reference_type: null })
  })

  it('returns the reference on the detail, and the invoice number when the PDF prints no OCR', async () => {
    const detail = async (tables: Record<string, { data?: unknown; error?: unknown }>) => {
      mockServiceClient.mockReturnValue(supabaseWith({ invoices: { data: SAMPLE_INVOICE, error: null }, ...tables }))
      const res = await getInvoice(
        makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`),
        detailParams(COMPANY_ID, INVOICE_ID),
      )
      expect(res.status).toBe(200)
      return (await res.json()).data
    }
    const giro = { company_settings: { data: { bankgiro: '5050-1055' }, error: null } }

    expect(await detail({ ...giro, invoice_reference_facts: { data: [facts()] } })).toMatchObject({
      payment_reference: '202600425',
      payment_reference_type: 'ocr',
    })
    // An English invoice prints "Reference" with the number.
    expect(
      await detail({ ...giro, invoice_reference_facts: { data: [facts({ customer: { language: 'en' } })] } }),
    ).toMatchObject({ payment_reference: '2026-0042', payment_reference_type: 'invoice_number' })
    // No giro printed: nothing to pay an OCR to.
    expect(await detail({ invoice_reference_facts: { data: [facts()] } })).toMatchObject({
      payment_reference: '2026-0042',
      payment_reference_type: 'invoice_number',
    })
    // Debited by Autogiro: the customer is asked for nothing.
    expect(
      await detail({ ...giro, invoice_reference_facts: { data: [facts({ autogiro_payer_number: '4711' })] } }),
    ).toMatchObject({ payment_reference: null, payment_reference_type: null })
  })

  it('is null on a credit note', async () => {
    mockServiceClient.mockReturnValue(
      supabaseWith({
        invoices: {
          data: { ...SAMPLE_INVOICE, invoice_number: 'KR-2026-0042', total: -12500, credited_invoice_id: DRAFT_ID },
          error: null,
        },
        company_settings: { data: { bankgiro: '5050-1055' }, error: null },
        invoice_reference_facts: { data: [facts()], error: null },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect((await res.json()).data).toMatchObject({ payment_reference: null, payment_reference_type: null })
  })

  it('answers 500 instead of a guessed reference when the settings cannot be read', async () => {
    mockServiceClient.mockReturnValue(
      supabaseWith({
        invoices: { data: SAMPLE_INVOICE, error: null },
        company_settings: { data: null, error: { message: 'connection reset' } },
      }),
    )

    const res = await getInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(500)
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
    // Sent and past its due date with money left: reported as overdue (crm#1084).
    expect(body.data.status).toBe('overdue')
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

// An eu_business customer whose number was never VIES-validated: the rule
// gives Swedish VAT, and the response has to say why (#2749).
const EU_BUSINESS_UNVALIDATED_CUSTOMER = {
  id: CUSTOMER_ID,
  customer_type: 'eu_business',
  vat_number: 'DE123456789',
  vat_number_validated: false,
  country: 'DE',
}

// An eu_business row with a VIES-validated German number whose country is
// Sweden: the contradiction #2025 refuses reverse charge for. The fixture
// carries MORE columns than the route may select (name, personal_number), so a
// test only sees `country` when the route actually asks for it.
const EU_BUSINESS_VALIDATED_COUNTRY_SE = {
  id: CUSTOMER_ID,
  name: 'Nordisk Filial GmbH',
  customer_type: 'eu_business',
  vat_number: 'DE123456789',
  vat_number_validated: true,
  country: 'SE',
  personal_number: null,
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
    // The same shape as GET (crm#1487).
    expect(body.data.amount_to_pay).toBe(12500)
    expect(body.data.ore_rounding_amount).toBe(0)
    // A domestic customer has nothing to explain: meta carries no warnings.
    expect(body.meta.warnings).toBeUndefined()
  })

  it('creates with Swedish VAT for an EU business without a validated number and explains it in meta.warnings (#2749)', async () => {
    withInvoiceWriteScope()
    const createdInvoice = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      invoice_number: null,
      customer_id: CUSTOMER_ID,
      status: 'draft',
      currency: 'SEK',
      subtotal: 10000,
      vat_amount: 2500,
      total: 12500,
      document_type: 'invoice',
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: EU_BUSINESS_UNVALIDATED_CUSTOMER, error: null },
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

    // The API warns and never refuses: 201, the draft exists with 25 %.
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.total).toBe(12500)
    expect(body.meta.warnings).toHaveLength(1)
    expect(body.meta.warnings[0]).toMatchObject({
      code: 'EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED',
      remediation: { tool: 'gnubok_update_customer', args: { customer_id: CUSTOMER_ID, vat_number: 'DE123456789' } },
    })
    expect(body.meta.warnings[0].message_en).toMatch(/Reverse charge is not applied/)
  })

  it('returns the same warning on a dry run, so an agent can see it before committing', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: EU_BUSINESS_UNVALIDATED_CUSTOMER, error: null },
      }),
    )

    const res = await createInvoice(
      makePostInvoice(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices`,
        {
          customer_id: CUSTOMER_ID,
          invoice_date: '2026-05-12',
          due_date: '2026-06-11',
          currency: 'SEK',
          items: [{ description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000 }],
        },
        { 'X-Dry-Run': 'true' },
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.meta.warnings?.map((w: { code: string }) => w.code)).toEqual(['EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED'])
  })

  // #2783: the country-SE rule (#2025) on the public API. A buyer established
  // in Sweden owes Swedish VAT whatever foreign VAT number it holds: huvudregeln
  // (ML 6 kap. 34 §) taxes a B2B service where the buyer is established, so
  // reverse charge only exists when that is another member state. The rate is
  // asserted on the dry-run preview and on the inserted row, never on the
  // response `data` of a live create: that is the mocked invoices fixture
  // echoed back, not the builder's arithmetic.
  it('charges Swedish VAT, not reverse charge, for a validated eu_business whose country is SE, and says why (#2783)', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: EU_BUSINESS_VALIDATED_COUNTRY_SE, error: null },
        company_settings: { data: { vat_registered: true }, error: null },
      }),
    )

    const res = await createInvoice(
      makePostInvoice(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices`,
        {
          customer_id: CUSTOMER_ID,
          invoice_date: '2026-05-12',
          due_date: '2026-06-11',
          currency: 'SEK',
          items: [{ description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000 }],
        },
        { 'X-Dry-Run': 'true' },
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({
      vat_treatment: 'standard_25',
      moms_ruta: '05',
      reverse_charge_text: null,
      vat_rate: 25,
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
    })
    expect(body.data.preview.items[0]).toMatchObject({ vat_rate: 25, vat_amount: 250 })
    expect(body.meta.warnings).toHaveLength(1)
    expect(body.meta.warnings[0]).toMatchObject({
      code: 'EU_BUSINESS_COUNTRY_IS_SE',
      remediation: { tool: 'gnubok_update_customer', args: { customer_id: CUSTOMER_ID } },
    })
    expect(body.meta.warnings[0].message_en).toMatch(/customer's country is Sweden/)
    expect(body.meta.warnings[0].message_sv).toMatch(/kundens land är Sverige/)
  })

  it('writes the SE-country draft with Swedish VAT and returns the warning on the live create too (#2783)', async () => {
    withInvoiceWriteScope()
    const inserts: InsertCapture[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          customers: { data: EU_BUSINESS_VALIDATED_COUNTRY_SE, error: null },
          company_settings: { data: { vat_registered: true }, error: null },
          invoices: {
            data: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', customer_id: CUSTOMER_ID, status: 'draft' },
            error: null,
          },
          invoice_items: { data: null, error: null },
        },
        inserts,
      ),
    )

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [{ description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000 }],
      }),
      companyParams(COMPANY_ID),
    )

    // Warn, never refuse.
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.meta.warnings.map((w: { code: string }) => w.code)).toEqual(['EU_BUSINESS_COUNTRY_IS_SE'])

    // What actually lands in the table: Swedish VAT, no reverse-charge notice.
    const invoiceRow = inserts.find((capture) => capture.table === 'invoices')?.payload
    expect(invoiceRow).toMatchObject({
      vat_treatment: 'standard_25',
      moms_ruta: '05',
      reverse_charge_text: null,
      vat_amount: 250,
      total: 1250,
    })
    const itemRows = inserts.find((capture) => capture.table === 'invoice_items')?.payload as Array<{ vat_rate: number }>
    expect(itemRows.map((row) => row.vat_rate)).toEqual([25])
  })

  it('still reverse-charges a genuinely foreign eu_business with a validated number, silently (#2783)', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: { ...EU_BUSINESS_VALIDATED_COUNTRY_SE, country: 'DE' }, error: null },
        company_settings: { data: { vat_registered: true }, error: null },
      }),
    )

    const res = await createInvoice(
      makePostInvoice(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices`,
        {
          customer_id: CUSTOMER_ID,
          invoice_date: '2026-05-12',
          due_date: '2026-06-11',
          currency: 'SEK',
          items: [{ description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000 }],
        },
        { 'X-Dry-Run': 'true' },
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({
      vat_treatment: 'reverse_charge',
      moms_ruta: '39',
      vat_rate: 0,
      vat_amount: 0,
      total: 1000,
    })
    expect(body.data.preview.reverse_charge_text).toMatch(/Reverse charge/)
    expect(body.data.preview.items[0]).toMatchObject({ vat_rate: 0, vat_amount: 0 })
    // 0 % to a reverse-charge customer is the rule: nothing to explain.
    expect(body.meta.warnings).toBeUndefined()
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

  it('persists default_dimensions + items[].dimensions on the draft', async () => {
    withInvoiceWriteScope()
    const createdInvoice = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      invoice_number: null,
      customer_id: CUSTOMER_ID,
      status: 'draft',
      document_type: 'invoice',
    }
    let insertedInvoice: Record<string, unknown> | null = null
    let insertedItems: Array<Record<string, unknown>> | null = null
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        if (table === 'invoices') {
          return new Proxy({}, {
            get(_t, prop) {
              if (prop === 'insert') {
                return (row: Record<string, unknown>) => {
                  insertedInvoice = row
                  return new Proxy({}, {
                    get(_t2, prop2) {
                      if (prop2 === 'then') {
                        return (r: (v: unknown) => void) => r({ data: createdInvoice, error: null })
                      }
                      return () => new Proxy({}, this!)
                    },
                  })
                }
              }
              if (prop === 'then') {
                return (r: (v: unknown) => void) => r({ data: createdInvoice, error: null })
              }
              return () => new Proxy({}, this!)
            },
          })
        }
        if (table === 'invoice_items') {
          return new Proxy({}, {
            get(_t, prop) {
              if (prop === 'insert') {
                return (rows: Array<Record<string, unknown>>) => {
                  insertedItems = rows
                  return new Proxy({}, {
                    get(_t2, prop2) {
                      if (prop2 === 'then') {
                        return (r: (v: unknown) => void) => r({ data: null, error: null })
                      }
                      return () => new Proxy({}, this!)
                    },
                  })
                }
              }
              if (prop === 'then') {
                return (r: (v: unknown) => void) => r({ data: null, error: null })
              }
              return () => new Proxy({}, this!)
            },
          })
        }
        return new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              const data = table === 'company_members'
                ? { company_id: COMPANY_ID, role: 'owner' }
                : table === 'customers'
                  ? SWEDISH_BUSINESS_CUSTOMER
                  : null
              return (r: (v: unknown) => void) => r({ data, error: null })
            }
            return () => new Proxy({}, this!)
          },
        })
      },
    })

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        default_dimensions: { '6': 'P001' },
        items: [
          {
            description: 'Konsultation',
            quantity: 8,
            unit: 'tim',
            unit_price: 1250,
            dimensions: { '1': 'KS01' },
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(insertedInvoice).not.toBeNull()
    expect(insertedInvoice!.default_dimensions).toEqual({ '6': 'P001' })
    expect(insertedItems).not.toBeNull()
    expect(insertedItems![0].dimensions).toEqual({ '1': 'KS01' })
  })

  it('dry-run preview carries default_dimensions and per-item dimensions', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: SWEDISH_BUSINESS_CUSTOMER, error: null },
      }),
    )

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?dry_run=true`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        default_dimensions: { '6': 'P001' },
        items: [
          {
            description: 'Konsultation',
            quantity: 8,
            unit: 'tim',
            unit_price: 1250,
            dimensions: { '1': 'KS01' },
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview.default_dimensions).toEqual({ '6': 'P001' })
    expect(body.data.preview.items[0].dimensions).toEqual({ '1': 'KS01' })
  })

  // ── ROT/RUT + article linkage (#895) ────────────────────────────

  // Valid 12-digit personnummer (Luhn-checked); same fixture family as
  // lib/invoices/__tests__/rot-rut-file.test.ts.
  const VALID_PNR = '198406012388'

  it('computes ROT deduction server-side and persists deduction fields', async () => {
    withInvoiceWriteScope()
    const createdInvoice = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', status: 'draft' }
    let insertedInvoice: Record<string, unknown> | null = null
    let insertedItems: Array<Record<string, unknown>> | null = null
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        const handler: ProxyHandler<object> = {
          get(_t, prop) {
            if (prop === 'insert') {
              return (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
                if (table === 'invoices') insertedInvoice = rows as Record<string, unknown>
                if (table === 'invoice_items') insertedItems = rows as Array<Record<string, unknown>>
                return new Proxy({}, handler)
              }
            }
            if (prop === 'then') {
              const data =
                table === 'company_members'
                  ? { company_id: COMPANY_ID, role: 'owner' }
                  : table === 'customers'
                    ? SWEDISH_BUSINESS_CUSTOMER
                    : table === 'invoices'
                      ? createdInvoice
                      : null
              return (r: (v: unknown) => void) => r({ data, error: null })
            }
            return () => new Proxy({}, handler)
          },
        }
        return new Proxy({}, handler)
      },
    })

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        deduction_personnummer: VALID_PNR,
        deduction_housing_designation: 'Almgren 1:23',
        items: [
          {
            description: 'Takarbete',
            quantity: 10,
            unit: 'tim',
            unit_price: 1000,
            deduction_type: 'rot',
            labor_hours: 10,
            work_type: 'BYGG',
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(insertedInvoice).not.toBeNull()
    // ROT = 30% of the labor incl. moms (HUSFL 6-9 §§): 30% x 12 500 = 3 750.
    expect(insertedInvoice!.deduction_total).toBe(3750)
    // Personnummer never stored in plaintext: ciphertext + last4 only.
    expect(insertedInvoice!.deduction_personnummer_encrypted).toBeTruthy()
    expect(insertedInvoice!.deduction_personnummer_encrypted).not.toContain(VALID_PNR)
    expect(insertedInvoice!.deduction_personnummer_last4).toBe('2388')
    // Customer share: total 12500 minus the 3750 Skatteverket pays via 1513.
    expect(insertedInvoice!.remaining_amount).toBe(8750)
    expect(insertedItems).not.toBeNull()
    expect(insertedItems![0].deduction_type).toBe('rot')
    expect(insertedItems![0].deduction_amount).toBe(3750)
    expect(insertedItems![0].work_type).toBe('BYGG')
    expect(insertedItems![0].labor_hours).toBe(10)
    // Invoice-level fastighetsbeteckning stamped onto the deduction line.
    expect(insertedItems![0].housing_designation).toBe('Almgren 1:23')
  })

  it('rejects a ROT line without personnummer/housing info (400 INVOICE_CREATE_ROT_RUT_VALIDATION)', async () => {
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
        items: [
          {
            description: 'Takarbete',
            quantity: 10,
            unit: 'tim',
            unit_price: 1000,
            deduction_type: 'rot',
            labor_hours: 10,
            work_type: 'BYGG',
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREATE_ROT_RUT_VALIDATION')
  })

  it('dry-run preview computes deduction_total and never echoes the encrypted personnummer', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: SWEDISH_BUSINESS_CUSTOMER, error: null },
      }),
    )

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices?dry_run=true`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        deduction_personnummer: VALID_PNR,
        deduction_housing_designation: 'Almgren 1:23',
        items: [
          {
            description: 'Städning',
            quantity: 4,
            unit: 'tim',
            unit_price: 500,
            deduction_type: 'rut',
            labor_hours: 4,
            work_type: 'STAD',
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    // RUT = 50% of the labor incl. moms (HUSFL 6-9 §§): 50% x 2 500 = 1 250.
    expect(body.data.preview.deduction_total).toBe(1250)
    expect(body.data.preview.deduction_personnummer_last4).toBe('2388')
    expect(body.data.preview.deduction_personnummer_encrypted).toBeUndefined()
    expect(body.data.preview.items[0].deduction_amount).toBe(1250)
  })

  it('persists article_id + revenue_account on line items (validated against the chart)', async () => {
    withInvoiceWriteScope()
    const ARTICLE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const createdInvoice = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', status: 'draft' }
    let insertedItems: Array<Record<string, unknown>> | null = null
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        const handler: ProxyHandler<object> = {
          get(_t, prop) {
            if (prop === 'insert') {
              return (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
                if (table === 'invoice_items') insertedItems = rows as Array<Record<string, unknown>>
                return new Proxy({}, handler)
              }
            }
            if (prop === 'then') {
              const data =
                table === 'company_members'
                  ? { company_id: COMPANY_ID, role: 'owner' }
                  : table === 'customers'
                    ? SWEDISH_BUSINESS_CUSTOMER
                    : table === 'chart_of_accounts'
                      ? [{ account_number: '3041' }]
                      : table === 'articles'
                        ? [{ id: ARTICLE_ID }]
                        : table === 'invoices'
                          ? createdInvoice
                          : null
              return (r: (v: unknown) => void) => r({ data, error: null })
            }
            return () => new Proxy({}, handler)
          },
        }
        return new Proxy({}, handler)
      },
    })

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [
          {
            description: 'Takarbete',
            quantity: 1,
            unit: 'st',
            unit_price: 5000,
            article_id: ARTICLE_ID,
            revenue_account: '3041',
          },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(insertedItems).not.toBeNull()
    expect(insertedItems![0].article_id).toBe(ARTICLE_ID)
    expect(insertedItems![0].revenue_account).toBe('3041')
  })

  it('persists a class-2 posting account on an invoice item', async () => {
    withInvoiceWriteScope()
    const createdInvoice = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', status: 'draft' }
    let insertedItems: Array<Record<string, unknown>> | null = null
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        const handler: ProxyHandler<object> = {
          get(_target, prop) {
            if (prop === 'insert') {
              return (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
                if (table === 'invoice_items') insertedItems = rows as Array<Record<string, unknown>>
                return new Proxy({}, handler)
              }
            }
            if (prop === 'then') {
              const data = table === 'company_members'
                ? { company_id: COMPANY_ID, role: 'owner' }
                : table === 'customers'
                  ? SWEDISH_BUSINESS_CUSTOMER
                  : table === 'chart_of_accounts'
                    ? [{ account_number: '2897' }]
                    : table === 'invoices'
                      ? createdInvoice
                      : null
              return (resolve: (value: unknown) => void) => resolve({ data, error: null })
            }
            return () => new Proxy({}, handler)
          },
        }
        return new Proxy({}, handler)
      },
    })

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [
          { description: 'Deposition', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 0, revenue_account: '2897' },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(insertedItems![0].revenue_account).toBe('2897')
  })

  it('rejects a class-2 posting account on a VAT-bearing line', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: SWEDISH_BUSINESS_CUSTOMER, error: null },
        chart_of_accounts: { data: [{ account_number: '2897' }], error: null },
      }),
    )

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [
          { description: 'Deposition', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 25, revenue_account: '2897' },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT')
  })

  it('rejects a revenue_account not in the chart of accounts', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: SWEDISH_BUSINESS_CUSTOMER, error: null },
        chart_of_accounts: { data: [], error: null },
      }),
    )

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [
          { description: 'x', quantity: 1, unit: 'st', unit_price: 100, revenue_account: '3999' },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREATE_REVENUE_ACCOUNT_INVALID')
  })

  it('rejects an article_id that belongs to another company (issue #2059)', async () => {
    // v1 runs on the service-role client with no RLS: the FK on
    // invoice_items.article_id proves existence only, so the scoped select in
    // the builder is the only tenancy guard for article linkage.
    withInvoiceWriteScope()
    const FOREIGN_ARTICLE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: SWEDISH_BUSINESS_CUSTOMER, error: null },
        articles: { data: [], error: null },
      }),
    )

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [
          { description: 'x', quantity: 1, unit: 'st', unit_price: 100, article_id: FOREIGN_ARTICLE },
        ],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREATE_ARTICLE_INVALID')
    expect(body.error.details).toEqual({ invalidArticleIds: [FOREIGN_ARTICLE] })
  })
})

// accounted#33: the delivery-note branch ignored the RPC error and
// inserted a note with a null number.
describe('POST /api/v1/companies/:companyId/invoices: delivery note numbering (#33)', () => {
  function deliveryNoteBody() {
    return {
      customer_id: CUSTOMER_ID,
      invoice_date: '2026-05-12',
      due_date: '2026-06-11',
      document_type: 'delivery_note',
      currency: 'SEK',
      items: [{ description: 'Leverans', quantity: 2, unit: 'st', unit_price: 500 }],
    }
  }

  function supabaseWithRpc(rpcResult: { data: unknown; error: unknown }, inserts: InsertCapture[]) {
    const createdNote = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      invoice_number: rpcResult.data,
      customer_id: CUSTOMER_ID,
      status: 'draft',
      document_type: 'delivery_note',
      currency: 'SEK',
      subtotal: 0,
      vat_amount: 0,
      total: 0,
    }
    const rpc = vi.fn().mockResolvedValue(rpcResult)
    return {
      rpc,
      client: {
        ...makeFlexibleSupabase(
          {
            company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
            customers: { data: SWEDISH_BUSINESS_CUSTOMER, error: null },
            invoices: { data: createdNote, error: null },
            invoice_items: { data: null, error: null },
          },
          inserts,
        ),
        rpc,
      },
    }
  }

  it('numbers the note from the FS-series at insert', async () => {
    withInvoiceWriteScope()
    const inserts: InsertCapture[] = []
    const { client, rpc } = supabaseWithRpc({ data: 'FS-20261000', error: null }, inserts)
    mockServiceClient.mockReturnValue(client)

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, deliveryNoteBody()),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    expect(rpc).toHaveBeenCalledWith('generate_delivery_note_number', { p_company_id: COMPANY_ID })
    const header = inserts.find((insert) => insert.table === 'invoices')?.payload as Record<string, unknown>
    expect(header.invoice_number).toBe('FS-20261000')
    expect(header.document_type).toBe('delivery_note')
  })

  it('returns 500 and inserts nothing when the number cannot be allocated', async () => {
    withInvoiceWriteScope()
    const inserts: InsertCapture[] = []
    const { client } = supabaseWithRpc(
      { data: null, error: { message: 'Company settings not found', code: 'P0001' } },
      inserts,
    )
    mockServiceClient.mockReturnValue(client)

    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, deliveryNoteBody()),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREATE_NUMBER_ASSIGN_FAILED')
    expect(inserts.find((insert) => insert.table === 'invoices')).toBeUndefined()
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

  it('updates default_dimensions (project tag) on a draft invoice (#895)', async () => {
    withInvoiceWriteScope()
    const draftInvoice = {
      id: INVOICE_ID,
      status: 'draft',
      invoice_date: '2026-05-12',
      due_date: '2026-06-11',
      default_dimensions: {},
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...draftInvoice, default_dimensions: { '6': 'P001' } }, error: null },
      }),
    )

    const res = await updateInvoice(
      makePatchInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`, {
        default_dimensions: { '6': 'P001' },
      }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.default_dimensions).toEqual({ '6': 'P001' })
  })

  it('rejects a malformed default_dimensions bag', async () => {
    withInvoiceWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateInvoice(
      makePatchInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}`, {
        default_dimensions: { 'not-a-number': 'P001' },
      }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects forbidden structural fields (currency / customer_id)', async () => {
    // `items` used to belong here but is now a supported full-replace field
    // (see the [id]/__tests__/route.test.ts suite); customer_id and currency
    // remain immutable on PATCH.
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

// ──────────────────────────────────────────────────────────────────
// Er referens from the customer card's Fakturareferens (crm#1200)
// ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/companies/:companyId/invoices: Er referens and Märkning from the customer card', () => {
  // The customers mock honours select(), so a card value only reaches the
  // route when it actually selects invoice_reference and invoice_marking.
  const CUSTOMER_WITH_REFERENCE = {
    ...SWEDISH_BUSINESS_CUSTOMER,
    contact_person: 'Karin Ek',
    invoice_reference: 'KST 4410',
    invoice_marking: '4500012345',
  }

  async function create(body: Record<string, unknown>) {
    withInvoiceWriteScope()
    const inserts: InsertCapture[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          customers: { data: CUSTOMER_WITH_REFERENCE, error: null },
          invoices: { data: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', customer_id: CUSTOMER_ID, status: 'draft' }, error: null },
          invoice_items: { data: null, error: null },
        },
        inserts,
      ),
    )
    const res = await createInvoice(
      makePostInvoice(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, {
        customer_id: CUSTOMER_ID,
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        currency: 'SEK',
        items: [{ description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000 }],
        ...body,
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
    return inserts.find((capture) => capture.table === 'invoices')?.payload as Record<string, unknown>
  }

  it('writes the Fakturareferens when the request states none', async () => {
    expect((await create({})).your_reference).toBe('KST 4410')
  })

  it('reads an empty your_reference as none', async () => {
    expect((await create({ your_reference: '  ' })).your_reference).toBe('KST 4410')
  })

  it('keeps the your_reference the request states', async () => {
    expect((await create({ your_reference: 'Inköp 77' })).your_reference).toBe('Inköp 77')
  })

  it('writes the card\'s Märkning when the request states none (crm#1477)', async () => {
    expect((await create({})).invoice_marking).toBe('4500012345')
  })

  it('reads an empty invoice_marking as none', async () => {
    expect((await create({ invoice_marking: '  ' })).invoice_marking).toBe('4500012345')
  })

  it('keeps the invoice_marking the request states', async () => {
    expect((await create({ invoice_marking: 'Projekt Norr' })).invoice_marking).toBe('Projekt Norr')
  })
})
