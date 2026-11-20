/**
 * A bulk-created invoice is the invoice POST /invoices creates from the same
 * body: the same header row and the same line rows, field for field.
 *
 * bulk-create used to compute its own rows and read only part of
 * CreateInvoiceSchema, so a line discount, a text row, an article, a posting
 * account, a periodisering, a ROT line, a fakturamärkning or a payee account
 * was accepted and then dropped: the invoice went out at the undiscounted
 * price with none of them. Both doors now build through buildInvoiceWriteData;
 * this test holds them to one result.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `bulk-create parity tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
vi.mock('@/lib/invoices/ensure-invoice-number', () => ({
  ensureInvoiceNumber: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/currency/riksbanken', async () => {
  const actual = await vi.importActual<typeof import('@/lib/currency/riksbanken')>('@/lib/currency/riksbanken')
  return { ...actual, fetchExchangeRate: vi.fn().mockResolvedValue({ currency: 'EUR', rate: 11.4321, date: '2026-05-08' }) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as createInvoice } from '../../route'
import { POST as bulkCreate } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const INVOICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const ARTICLE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CASH_ACCOUNT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const USER_ID = 'user-1'

type Insert = { table: string; payload: unknown }

/** Keep only the columns a flat select() asked for, as PostgREST would. */
function projectRow(data: unknown, columns: string | null): unknown {
  if (!columns || columns.trim() === '*') return data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data
  const row = data as Record<string, unknown>
  const wanted = columns.split(',').map((c) => c.trim()).filter(Boolean)
  return Object.fromEntries(wanted.filter((c) => c in row).map((c) => [c, row[c]]))
}

function makeSupabase(byTable: Record<string, unknown>, inserts: Insert[]) {
  const chain = (table: string, columns: string | null): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            const data = byTable[table] ?? null
            return (resolve: (v: unknown) => void) =>
              resolve({ data: table === 'customers' ? projectRow(data, columns) : data, error: null })
          }
          if (prop === 'select') {
            return (requested?: unknown) => chain(table, typeof requested === 'string' ? requested : columns)
          }
          if (prop === 'insert') {
            return (payload: unknown) => {
              inserts.push({ table, payload })
              return chain(table, columns)
            }
          }
          return () => chain(table, columns)
        },
      },
    )
  return { from: vi.fn((table: string) => chain(table, null)) }
}

const TABLES: Record<string, unknown> = {
  company_members: { company_id: COMPANY_ID, role: 'owner' },
  customers: {
    id: CUSTOMER_ID,
    name: 'Kund AB',
    customer_type: 'swedish_business',
    vat_number: 'SE556677889901',
    vat_number_validated: true,
    country: 'SE',
    personal_number: null,
  },
  company_settings: { vat_registered: true, accounting_method: 'accrual' },
  chart_of_accounts: [{ account_number: '3041' }],
  articles: [{ id: ARTICLE_ID }],
  cash_accounts: {
    id: CASH_ACCOUNT_ID,
    company_id: COMPANY_ID,
    ledger_account: '1930',
    enabled: true,
    invoice_payee: true,
    bank_name: 'Banken',
    clearing_number: '8327',
    account_number: '1234567',
    bankgiro: '123-4567',
    plusgiro: null,
    swish: null,
    payee_iban: 'SE4550000000058398257466',
    bic: 'ESSESESS',
    bank_code: null,
    foreign_account_number: null,
  },
  invoices: { id: INVOICE_ID, invoice_number: null, status: 'draft' },
  invoice_items: null,
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-7777-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

/** The invoices + invoice_items rows each door writes for the same body. */
async function writesOf(invoice: Record<string, unknown>, tables: Record<string, unknown> = TABLES) {
  const single: Insert[] = []
  mockServiceClient.mockReturnValue(makeSupabase(tables, single))
  const singleRes = await createInvoice(post(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices`, invoice), params)
  expect(singleRes.status).toBe(201)

  const bulk: Insert[] = []
  mockServiceClient.mockReturnValue(makeSupabase(tables, bulk))
  const bulkRes = await bulkCreate(
    post(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/bulk-create`, { invoices: [invoice] }),
    params,
  )
  expect(bulkRes.status).toBe(200)
  const bulkBody = await bulkRes.json()
  expect(bulkBody.data.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })

  const rows = (inserts: Insert[], table: string) => inserts.filter((i) => i.table === table).map((i) => i.payload)
  return {
    single: { header: rows(single, 'invoices'), items: rows(single, 'invoice_items') },
    bulk: { header: rows(bulk, 'invoices'), items: rows(bulk, 'invoice_items') },
  }
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

describe('bulk-create writes the invoice POST /invoices writes', () => {
  it('keeps discounts, text rows, articles, posting accounts, periodisering, payee and header fields', async () => {
    const { single, bulk } = await writesOf({
      customer_id: CUSTOMER_ID,
      invoice_date: '2026-05-12',
      due_date: '2026-06-11',
      delivery_date: '2026-05-08',
      currency: 'EUR',
      your_reference: 'Anna',
      our_reference: 'Bo',
      invoice_marking: 'PO-77',
      notes: 'Tack',
      payment_link_url: 'https://pay.example.test/x',
      payment_link_auto: false,
      ore_rounding: true,
      qr_mode: 'bank_app',
      payment_cash_account_id: CASH_ACCOUNT_ID,
      default_dimensions: { '1': 'KS01' },
      items: [
        {
          description: 'Konsultation',
          quantity: 3,
          unit: 'tim',
          unit_price: 1234.5,
          discount_percent: 10,
          vat_rate: 25,
          article_id: ARTICLE_ID,
          revenue_account: '3041',
          dimensions: { '6': 'P001' },
        },
        { line_type: 'text', description: 'Avser maj', quantity: 0, unit: '', unit_price: 0 },
        {
          description: 'Support, sex månader',
          quantity: 1,
          unit: 'st',
          unit_price: 6000,
          accrual_period_start: '2026-06-01',
          accrual_period_end: '2026-11-30',
        },
      ],
    })

    expect(single.header).toHaveLength(1)
    expect(bulk.header).toEqual(single.header)
    expect(bulk.items).toEqual(single.items)

    // The single door's row is the reference; spell out what bulk used to drop.
    const header = single.header[0] as Record<string, unknown>
    expect(header).toMatchObject({
      subtotal: 9333.15,
      invoice_marking: 'PO-77',
      payment_link_url: 'https://pay.example.test/x',
      payment_link_auto: false,
      ore_rounding: true,
      payment_cash_account_id: CASH_ACCOUNT_ID,
      exchange_rate_date: '2026-05-08',
    })
    const items = single.items[0] as Array<Record<string, unknown>>
    expect(items[0]).toMatchObject({ discount_percent: 10, line_total: 3333.15, article_id: ARTICLE_ID, revenue_account: '3041' })
    expect(items[1]).toMatchObject({ line_type: 'text', line_total: 0 })
    expect(items[2]).toMatchObject({ accrual_period_start: '2026-06-01', accrual_balance_account: expect.any(String) })
  })

  it('keeps a ROT line with its server-side deduction and the encrypted personnummer', async () => {
    const { single, bulk } = await writesOf({
      customer_id: CUSTOMER_ID,
      invoice_date: '2026-05-12',
      due_date: '2026-06-11',
      currency: 'SEK',
      deduction_personnummer: '198406012388',
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
    })

    // The ciphertext carries a random IV, so it differs per write; both must
    // carry one and neither may hold the plaintext.
    const strip = (rows: unknown[]) =>
      rows.map((row) => {
        const { deduction_personnummer_encrypted: encrypted, ...rest } = row as Record<string, unknown>
        expect(encrypted).toEqual(expect.any(String))
        expect(encrypted).not.toContain('198406012388')
        return rest
      })
    expect(strip(bulk.header)).toEqual(strip(single.header))
    expect(bulk.items).toEqual(single.items)
    expect(single.header[0]).toMatchObject({ deduction_total: 3750, remaining_amount: 8750 })
  })
})

describe('bulk-create takes Er referens from the customer card as POST /invoices does (crm#1200)', () => {
  const withReference = {
    ...TABLES,
    customers: { ...(TABLES.customers as Record<string, unknown>), invoice_reference: 'KST 4410' },
  }
  const body = {
    customer_id: CUSTOMER_ID,
    invoice_date: '2026-05-12',
    due_date: '2026-06-11',
    currency: 'SEK',
    items: [{ description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
  }

  it('writes the Fakturareferens when the request states none', async () => {
    const { single, bulk } = await writesOf(body, withReference)
    expect((single.header[0] as Record<string, unknown>).your_reference).toBe('KST 4410')
    expect(bulk.header).toEqual(single.header)
  })

  it('keeps the your_reference the request states', async () => {
    const { single, bulk } = await writesOf({ ...body, your_reference: 'Anna' }, withReference)
    expect((single.header[0] as Record<string, unknown>).your_reference).toBe('Anna')
    expect(bulk.header).toEqual(single.header)
  })
})

describe('bulk-create takes Märkning from the customer card as POST /invoices does (crm#1477)', () => {
  const withMarking = {
    ...TABLES,
    customers: { ...(TABLES.customers as Record<string, unknown>), invoice_marking: '4500012345' },
  }
  const body = {
    customer_id: CUSTOMER_ID,
    invoice_date: '2026-05-12',
    due_date: '2026-06-11',
    currency: 'SEK',
    items: [{ description: 'Konsultation', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
  }

  it('writes the card\'s Märkning when the request states none', async () => {
    const { single, bulk } = await writesOf(body, withMarking)
    expect((single.header[0] as Record<string, unknown>).invoice_marking).toBe('4500012345')
    expect(bulk.header).toEqual(single.header)
  })

  it('keeps the invoice_marking the request states', async () => {
    const { single, bulk } = await writesOf({ ...body, invoice_marking: 'Projekt Norr' }, withMarking)
    expect((single.header[0] as Record<string, unknown>).invoice_marking).toBe('Projekt Norr')
    expect(bulk.header).toEqual(single.header)
  })
})
