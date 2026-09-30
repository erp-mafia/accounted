/**
 * POST /api/v1/companies/:companyId/invoices with a per-invoice VAT treatment
 * (#2906): a Swedish buyer with goods shipped to Norway is an export (0 %,
 * ruta 36), stated on the invoice instead of forced by the customer record.
 * The rules are resolveInvoiceVatRules' (unit-tested there); these pin the
 * door: auth, validation, refusal codes, dry run and what is written.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
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
import { EXPORT_NOTICE_SV } from '@/lib/invoices/vat-rules'
import { POST as createInvoice } from '../route'
import { POST as bulkCreateInvoices } from '../bulk-create/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
type Capture = { table: string; op: 'update' | 'insert' | 'delete'; payload: unknown }

/** Keep only the columns a flat select() asked for, as PostgREST would. */
function projectRow(data: unknown, columns: string | null): unknown {
  if (!columns || columns.trim() === '*') return data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data
  const row = data as Record<string, unknown>
  const wanted = columns.split(',').map((column) => column.trim()).filter(Boolean)
  return Object.fromEntries(wanted.filter((column) => column in row).map((column) => [column, row[column]]))
}

/** Per-table result queues (the last one repeats) plus a write capture log. */
function makeSupabase(byTable: Record<string, MockResult | MockResult[]>, captures: Capture[] = []) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const buildChain = (table: string, columns: string | null): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(table)
              const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
              resolve(table === 'customers' ? { ...next, data: projectRow(next.data, columns) } : next)
            }
          }
          if (prop === 'select') {
            return (requested?: unknown) => buildChain(table, typeof requested === 'string' ? requested : columns)
          }
          if (prop === 'update' || prop === 'insert') {
            return (payload: unknown) => {
              captures.push({ table, op: prop, payload })
              return buildChain(table, columns)
            }
          }
          if (prop === 'delete') {
            return () => {
              captures.push({ table, op: 'delete', payload: undefined })
              return buildChain(table, columns)
            }
          }
          return (..._args: unknown[]) => buildChain(table, columns)
        },
      },
    )
  return { from: vi.fn((table: string) => buildChain(table, null)), rpc: vi.fn() }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const INVOICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

// A Swedish company: by default every invoice to it carries 25 %.
const SWEDISH_BUYER = {
  id: CUSTOMER_ID,
  name: 'Svensk Handel AB',
  customer_type: 'swedish_business',
  vat_number: 'SE556677889901',
  vat_number_validated: true,
  country: 'SE',
  personal_number: null,
}

const BODY = {
  customer_id: CUSTOMER_ID,
  invoice_date: '2026-09-27',
  due_date: '2026-10-27',
  currency: 'SEK',
  items: [{ description: 'Pallställ', quantity: 2, unit: 'st', unit_price: 5000 }],
}

function post(body: unknown, opts: { auth?: boolean; dryRun?: boolean; path?: string } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': 'idem1234-2906-4abc-8def-1234567890ab',
  }
  if (opts.auth !== false) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices${opts.path ?? ''}${opts.dryRun ? '?dry_run=true' : ''}`
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

function baseTables(extra: Record<string, MockResult | MockResult[]> = {}) {
  return {
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    customers: { data: SWEDISH_BUYER, error: null },
    company_settings: { data: { vat_registered: true }, error: null },
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:write'],
    mode: 'live',
  })
})

describe('POST /invoices with vat_treatment + delivery_country (#2906)', () => {
  it('returns 401 without a bearer token', async () => {
    mockServiceClient.mockReturnValue(makeSupabase({}))
    const res = await createInvoice(post({ ...BODY, vat_treatment: 'export', delivery_country: 'NO' }, { auth: false }), params)
    expect(res.status).toBe(401)
  })

  it.each([
    ['a treatment outside the vocabulary', { vat_treatment: 'standard_25' }],
    ['a country name instead of a code', { vat_treatment: 'export', delivery_country: 'Norway' }],
    ['an unassigned code that would read as outside the EU', { vat_treatment: 'export', delivery_country: 'ZZ' }],
  ])('rejects %s (400 VALIDATION_ERROR)', async (_label, extra) => {
    mockServiceClient.mockReturnValue(makeSupabase(baseTables()))
    const res = await createInvoice(post({ ...BODY, ...extra }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 INVOICE_CUSTOMER_NOT_FOUND for a customer outside the company', async () => {
    mockServiceClient.mockReturnValue(makeSupabase(baseTables({ customers: { data: null, error: null } })))
    const res = await createInvoice(post({ ...BODY, vat_treatment: 'export', delivery_country: 'NO' }), params)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INVOICE_CUSTOMER_NOT_FOUND')
  })

  it('refuses an export to an EU country, and writes nothing', async () => {
    const captures: Capture[] = []
    mockServiceClient.mockReturnValue(makeSupabase(baseTables(), captures))
    const res = await createInvoice(post({ ...BODY, vat_treatment: 'export', delivery_country: 'DK' }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_MISMATCH')
    expect(body.error.details).toMatchObject({ delivery_country: 'DK', required: 'outside_eu' })
    expect(captures.filter((c) => c.table.startsWith('invoice'))).toEqual([])
  })

  it('refuses an intra-EU supply to a buyer with only a Swedish VAT number', async () => {
    mockServiceClient.mockReturnValue(makeSupabase(baseTables()))
    const res = await createInvoice(post({ ...BODY, vat_treatment: 'reverse_charge', delivery_country: 'DE' }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_VAT_TREATMENT_BUYER_VAT_NUMBER_REQUIRED')
    expect(body.error.details.reason).toBe('not_another_member_state')
  })

  it('dry run returns the resulting treatment so an integration can verify it before sending', async () => {
    const captures: Capture[] = []
    mockServiceClient.mockReturnValue(makeSupabase(baseTables(), captures))
    const res = await createInvoice(post({ ...BODY, vat_treatment: 'export', delivery_country: 'NO' }, { dryRun: true }), params)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      status: 'draft',
      vat_treatment: 'export',
      moms_ruta: '36',
      reverse_charge_text: EXPORT_NOTICE_SV,
      vat_treatment_override: 'export',
      delivery_country: 'NO',
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
    })
    expect(body.data.preview.items[0]).toMatchObject({ vat_rate: 0, vat_amount: 0 })
    expect(body.meta.warnings).toBeUndefined()
    expect(captures.filter((c) => c.op === 'insert')).toEqual([])
  })

  it('creates the draft as an export of goods: 0 %, ruta 36, the statement stored', async () => {
    const captures: Capture[] = []
    mockServiceClient.mockReturnValue(
      makeSupabase(
        baseTables({
          invoices: { data: { id: INVOICE_ID, customer_id: CUSTOMER_ID, status: 'draft', total: 10000 }, error: null },
          invoice_items: { data: null, error: null },
        }),
        captures,
      ),
    )

    const res = await createInvoice(post({ ...BODY, vat_treatment: 'export', delivery_country: 'NO' }), params)

    expect(res.status).toBe(201)
    const invoiceInsert = captures.find((c) => c.table === 'invoices' && c.op === 'insert')?.payload
    expect(invoiceInsert).toMatchObject({
      vat_treatment: 'export',
      moms_ruta: '36',
      reverse_charge_text: EXPORT_NOTICE_SV,
      vat_amount: 0,
      total: 10000,
      vat_treatment_override: 'export',
      delivery_country: 'NO',
    })
    const itemsInsert = captures.find((c) => c.table === 'invoice_items' && c.op === 'insert')?.payload as Array<{
      vat_rate: number
    }>
    expect(itemsInsert[0].vat_rate).toBe(0)
  })

  it('without the fields the customer still decides: 25 % for the Swedish buyer, nothing stored', async () => {
    const captures: Capture[] = []
    mockServiceClient.mockReturnValue(
      makeSupabase(
        baseTables({
          invoices: { data: { id: INVOICE_ID, customer_id: CUSTOMER_ID, status: 'draft', total: 12500 }, error: null },
          invoice_items: { data: null, error: null },
        }),
        captures,
      ),
    )

    const res = await createInvoice(post(BODY), params)

    expect(res.status).toBe(201)
    expect(captures.find((c) => c.table === 'invoices' && c.op === 'insert')?.payload).toMatchObject({
      vat_treatment: 'standard_25',
      moms_ruta: '05',
      vat_amount: 2500,
      vat_treatment_override: null,
      delivery_country: null,
    })
  })
})

describe('POST /invoices/bulk-create refuses a per-invoice VAT treatment it cannot apply', () => {
  it('fails that item with VALIDATION_ERROR instead of silently invoicing the customer default', async () => {
    const captures: Capture[] = []
    mockServiceClient.mockReturnValue(makeSupabase(baseTables(), captures))

    const res = await bulkCreateInvoices(
      post({ invoices: [{ ...BODY, vat_treatment: 'export', delivery_country: 'NO' }] }, { path: '/bulk-create' }),
      params,
    )

    const body = await res.json()
    const item = body.data.results[0]
    expect(item.ok).toBe(false)
    expect(item.error).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'vat_treatment' } })
    expect(captures.filter((c) => c.table === 'invoices')).toEqual([])
  })
})
