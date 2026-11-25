/**
 * POST /api/v1/companies/:companyId/invoices/:id/mark-paid: the door's side
 * of the sale-first rule (lib/invoices/sale-first.ts). The dry run plans the
 * sale itself (a refusal is the commit's refusal too); the commit goes through
 * settleInvoicePayment, which owns the rule and has its own suite, so it is
 * stubbed here and the test pins how the route maps its answers.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Whether a credit note is active: mocked so it takes no slot in the Supabase
// mock; the read is pinned by lib/invoices/__tests__/active-credit-note.test.ts.
const { mockHasActiveCreditNote } = vi.hoisted(() => ({ mockHasActiveCreditNote: vi.fn(async (..._args: unknown[]) => false) }))
vi.mock('@/lib/invoices/active-credit-note', () => ({ invoiceHasActiveCreditNote: mockHasActiveCreditNote }))

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

const { mockPlanSale, mockSettle } = vi.hoisted(() => ({
  mockPlanSale: vi.fn(),
  mockSettle: vi.fn(),
}))
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: mockPlanSale,
}))
vi.mock('@/lib/invoices/settle-invoice-payment', () => ({
  settleInvoicePayment: mockSettle,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as markPaid } from '../route'
import { eventBus } from '@/lib/events'
import { createTableMockSupabase } from '@/tests/helpers'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SALE_JE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PAYMENT_JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-paid`

let idemCounter = 0
function makeRequest(url: string, body?: unknown): Request {
  idemCounter += 1
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem${String(idemCounter).padStart(4, '0')}-1010-4abc-8def-1234567890ab`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}
function detailParams() {
  return { params: Promise.resolve({ companyId: COMPANY_ID, id: INVOICE_ID }) }
}

// A deferring company's invoice, sent without its verifikat.
const SENT_UNBOOKED = {
  id: INVOICE_ID,
  invoice_number: '2026-0042',
  customer_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  invoice_date: '2026-05-02',
  due_date: '2026-06-01',
  status: 'sent',
  document_type: 'invoice',
  currency: 'SEK',
  subtotal: 10000,
  vat_amount: 2500,
  total: 12500,
  remaining_amount: 12500,
  paid_amount: 0,
  paid_at: null,
  vat_treatment: 'standard_25',
  moms_ruta: '05',
  credited_invoice_id: null,
  journal_entry_id: null,
  customer: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Acme AB' },
  items: [],
}
const PAID = { ...SENT_UNBOOKED, status: 'paid', remaining_amount: 0, paid_amount: 12500, paid_at: '2026-05-12T12:00:00Z' }

const SALE_ENTRY = {
  entry_date: '2026-05-02',
  description: 'Faktura 2026-0042',
  lines: [
    { account_number: '1510', debit_amount: 12500, credit_amount: 0, line_description: null },
    { account_number: '3001', debit_amount: 0, credit_amount: 10000, line_description: null },
    { account_number: '2611', debit_amount: 0, credit_amount: 2500, line_description: null },
  ],
  total_debit: 12500,
  total_credit: 12500,
  balanced: true,
  note: 'n',
}

function useSupabase(invoices: unknown) {
  mockServiceClient.mockReturnValue(
    createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      invoices: invoices as never,
      company_settings: { data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null },
      invoice_payments: { data: { id: 'ip-1' }, error: null },
    }).supabase,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:write'],
    mode: 'live',
  })
  mockPlanSale.mockResolvedValue({ ok: true, required: false })
})

describe('v1 mark-paid: sale first (defer_invoice_booking)', () => {
  it('dry run shows the sale verifikat the commit books first', async () => {
    useSupabase({ data: SENT_UNBOOKED, error: null })
    mockPlanSale.mockResolvedValue({ ok: true, required: true, invoiceId: INVOICE_ID, entry: SALE_ENTRY })

    const res = await markPaid(makeRequest(`${URL_BASE}?dry_run=true`, { payment_date: '2026-05-12' }), detailParams())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview.books_sale_first).toBe(true)
    expect(body.data.preview.sale_entry).toEqual(SALE_ENTRY)
    expect(mockPlanSale).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID }),
      expect.objectContaining({ id: INVOICE_ID }),
      { settlementDate: '2026-05-12' },
    )
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('lines that clear what a sale booking the öresavrundning leaves on 1510 settle the invoice', async () => {
    // The sale books 1510 at the rounded "Att betala" 1 000 and the 0,25 on
    // 3740, so the reskontra's 999,75 is paid by clearing 1 000, no 3740.
    useSupabase({
      data: { ...SENT_UNBOOKED, subtotal: 799.8, vat_amount: 199.95, total: 999.75, remaining_amount: 999.75 },
      error: null,
    })
    const roundedSale = {
      ...SALE_ENTRY,
      lines: [
        { account_number: '1510', debit_amount: 1000, credit_amount: 0, line_description: null },
        { account_number: '3001', debit_amount: 0, credit_amount: 799.8, line_description: null },
        { account_number: '2611', debit_amount: 0, credit_amount: 199.95, line_description: null },
        { account_number: '3740', debit_amount: 0, credit_amount: 0.25, line_description: null },
      ],
      total_debit: 1000,
      total_credit: 1000,
    }
    mockPlanSale.mockResolvedValue({ ok: true, required: true, invoiceId: INVOICE_ID, entry: roundedSale, receivableSek: 1000 })

    const res = await markPaid(
      makeRequest(`${URL_BASE}?dry_run=true`, {
        payment_date: '2026-05-12',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
        ],
      }),
      detailParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview.status).toBe('paid')
    expect(body.data.preview.remaining_amount).toBe(0)
    expect(body.data.preview.books_sale_first).toBe(true)
    expect(body.data.preview.sale_entry).toEqual(roundedSale)
    // One plan serves the lines' plan and the preview.
    expect(mockPlanSale).toHaveBeenCalledTimes(1)
  })

  it('dry run refuses with the Bokför step code and details.sale_first', async () => {
    useSupabase({ data: SENT_UNBOOKED, error: null })
    mockPlanSale.mockResolvedValue({
      ok: false,
      code: 'INVOICE_BOOK_NO_FISCAL_PERIOD',
      details: { invoiceDate: '2026-05-02', sale_first: true, invoice_id: INVOICE_ID },
    })

    const res = await markPaid(makeRequest(`${URL_BASE}?dry_run=true`, { payment_date: '2026-05-12' }), detailParams())

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_BOOK_NO_FISCAL_PERIOD')
    expect(body.error.details).toMatchObject({ sale_first: true, invoice_id: INVOICE_ID })
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('dry run of an invoice that needs nothing first carries no sale fields', async () => {
    useSupabase({ data: { ...SENT_UNBOOKED, journal_entry_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, error: null })

    const res = await markPaid(makeRequest(`${URL_BASE}?dry_run=true`, { payment_date: '2026-05-12' }), detailParams())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).not.toHaveProperty('books_sale_first')
    expect(body.data.preview).not.toHaveProperty('sale_entry')
  })

  it('custom lines that book the revenue themselves (no 151x credit) plan no sale', async () => {
    useSupabase({ data: SENT_UNBOOKED, error: null })

    const res = await markPaid(
      makeRequest(`${URL_BASE}?dry_run=true`, {
        payment_date: '2026-05-12',
        lines: [
          { account_number: '1930', debit_amount: 12500, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
          { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
        ],
      }),
      detailParams(),
    )

    expect(res.status).toBe(200)
    expect(mockPlanSale).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.data.preview).not.toHaveProperty('books_sale_first')
  })

  it('custom lines that clear 1510 (a partial payment) plan the sale', async () => {
    useSupabase({ data: SENT_UNBOOKED, error: null })
    mockPlanSale.mockResolvedValue({ ok: true, required: true, invoiceId: INVOICE_ID, entry: SALE_ENTRY })

    const res = await markPaid(
      makeRequest(`${URL_BASE}?dry_run=true`, {
        payment_date: '2026-05-12',
        lines: [
          { account_number: '1930', debit_amount: 5000, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 5000 },
        ],
      }),
      detailParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview.status).toBe('partially_paid')
    expect(body.data.preview.books_sale_first).toBe(true)
  })

  it('commit returns the sale verifikat the payment booked first', async () => {
    useSupabase([
      { data: SENT_UNBOOKED, error: null },
      { data: PAID, error: null },
    ])
    mockSettle.mockResolvedValue({
      ok: true,
      newStatus: 'paid',
      newPaidAmount: 12500,
      newRemaining: 0,
      journalEntryId: PAYMENT_JE_ID,
      paidAt: '2026-05-12T12:00:00Z',
      saleJournalEntryId: SALE_JE_ID,
      warnings: [],
    })

    const res = await markPaid(makeRequest(URL_BASE, { payment_date: '2026-05-12' }), detailParams())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.journal_entry_id).toBe(PAYMENT_JE_ID)
    expect(body.data.sale_journal_entry_id).toBe(SALE_JE_ID)
  })

  it('commit refuses with the Bokför step code when settleInvoicePayment answers SALE_FIRST_REFUSED', async () => {
    useSupabase({ data: SENT_UNBOOKED, error: null })
    mockSettle.mockResolvedValue({
      ok: false,
      code: 'SALE_FIRST_REFUSED',
      refusal: {
        ok: false,
        code: 'PERIOD_LOCKED',
        details: { reason: 'company_lock_date_covers', payment_date: '2026-05-12', sale_first: true, invoice_id: INVOICE_ID },
      },
    })

    const res = await markPaid(makeRequest(URL_BASE, { payment_date: '2026-05-12' }), detailParams())

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.details).toMatchObject({ sale_first: true, payment_date: '2026-05-12' })
  })
})
