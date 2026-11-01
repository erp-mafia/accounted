/**
 * The dashboard bank match of an invoice a deferring company has not booked
 * yet (defer_invoice_booking): the sale is booked first through the Bokför
 * step (lib/invoices/sale-first.ts), then the payment verifikat. A refusal
 * there refuses the match with the Bokför code and nothing is written. The rule itself has its own
 * suite; here it is a controllable mock and the tests pin the route's wiring:
 * what it asks the plan, when it books, what it answers. The preview route
 * shows the same plan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
  makeInvoice,
  makeCustomer,
} from '@/tests/helpers'

const mockPlanSale = vi.fn()
const mockBookSale = vi.fn()
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: (...args: unknown[]) => mockPlanSale(...args),
  bookSaleBeforeSettlement: (...args: unknown[]) => mockBookSale(...args),
}))

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

const mockCreateInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bookkeeping/invoice-entries')>()
  return {
    buildInvoiceCashLines: actual.buildInvoiceCashLines,
    createInvoiceCashEntry: (...args: unknown[]) => mockCreateInvoiceCashEntry(...args),
    getRevenueAccount: vi.fn().mockReturnValue('3001'),
    getOutputVatAccount: vi.fn().mockReturnValue('2611'),
  }
})

const mockFindUnresolvableAccounts = vi.fn()
vi.mock('@/lib/bookkeeping/account-validation', () => ({
  findUnresolvableAccounts: (...args: unknown[]) => mockFindUnresolvableAccounts(...args),
}))

const mockReverseEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
const mockCreateJournalEntry = vi.fn()
const mockCancelOrphanedEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  cancelOrphanedEntry: (...args: unknown[]) => mockCancelOrphanedEntry(...args),
}))

// Open: the gate has its own suites, and consumes no slot in the queued mock.
vi.mock('@/lib/transactions/is-booked', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/is-booked')>()),
  decideBankRowRebooking: vi.fn(async () => ({ outcome: 'open' })),
}))

vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: vi.fn() }))
vi.mock('@/lib/invoices/match-log', () => ({ logMatchEvent: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { POST } from '../route'
import { GET } from '../preview/route'

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000'

const SALE_ENTRY = {
  entry_date: '2024-06-01',
  description: 'Kundfaktura F-2024001',
  lines: [
    { account_number: '1510', debit_amount: 12500, credit_amount: 0, line_description: 'F-2024001' },
    { account_number: '3001', debit_amount: 0, credit_amount: 10000, line_description: 'F-2024001' },
    { account_number: '2611', debit_amount: 0, credit_amount: 2500, line_description: 'F-2024001' },
  ],
  total_debit: 12500,
  total_credit: 12500,
  balanced: true,
  note: 'preview',
}
const REQUIRED_PLAN = { ok: true, required: true, invoiceId: INVOICE_ID, entry: SALE_ENTRY, receivableSek: 12500 }
// 141.36 + 35.34 EUR at 11.123: the sale will leave 1965.44, the header at the rate says 1965.43.
const FOREIGN_INVOICE = { currency: 'EUR', exchange_rate: 11.123, total: 176.7, total_sek: 1965.43, remaining_amount: 176.7, subtotal: 141.36, vat_amount: 35.34 }
const FOREIGN_PLAN = { ...REQUIRED_PLAN, receivableSek: 1965.44 }
const NOT_REQUIRED = { ok: true, required: false }
const BOOKED = { ok: true, journalEntryId: 'je-sale', bookedHere: true, warnings: [] }
const NOTHING_BOOKED = { ok: true, journalEntryId: null, bookedHere: false, warnings: [] }
const INVOICE_DATE_LOCKED = {
  ok: false,
  code: 'PERIOD_LOCKED',
  details: { reason: 'period_locked_at_set', invoice_date: '2024-06-01', sale_first: true, invoice_id: INVOICE_ID },
}

/** An unbooked faktura of a deferring company, sent and open. */
function sentInvoice(overrides: Record<string, unknown> = {}) {
  return makeInvoice({
    id: INVOICE_ID,
    status: 'sent',
    invoice_date: '2024-06-01',
    total: 12500,
    remaining_amount: 12500,
    paid_amount: 0,
    subtotal: 10000,
    vat_amount: 2500,
    invoice_number: 'F-2024001',
    journal_entry_id: null,
    customer: makeCustomer(),
    ...overrides,
  } as Parameters<typeof makeInvoice>[0])
}

/** The reads every match makes before it writes, in the route's order. */
function enqueueReads(opts: { tx?: Record<string, unknown>; invoice?: Record<string, unknown>; method?: string } = {}) {
  enqueue({ data: makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null, date: '2024-06-15', ...opts.tx }), error: null })
  enqueue({ data: sentInvoice(opts.invoice), error: null })
  enqueue({ data: [], error: null }) // hard-duplicate check: no prior payment voucher
  enqueue({ data: { accounting_method: opts.method ?? 'accrual', entity_type: 'enskild_firma' }, error: null })
  enqueue({ data: [], error: null }) // resolveSettlementAccount: no cash accounts -> 1930
}

/** The writes after the payment verifikat, when the sale was booked first. */
function enqueueSettleWrites(opts: { invoicePdf?: boolean } = {}) {
  enqueue({ data: [{ id: 'tx-1' }], error: null }) // row claim
  enqueue({ data: [{ id: INVOICE_ID }], error: null }) // invoice CAS update
  enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
  // The invoice PDF lookup on the sale verifikat, re-attached to the payment.
  enqueue({
    data: opts.invoicePdf
      ? { storage_path: 'inv/F-2024001.pdf', file_name: 'F-2024001.pdf', file_size_bytes: 10, mime_type: 'application/pdf', sha256_hash: 'abc' }
      : null,
    error: null,
  })
  if (opts.invoicePdf) enqueue({ data: null, error: null }) // document_attachments insert
}

async function post(body: Record<string, unknown> = {}) {
  const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
    method: 'POST',
    body: { invoice_id: INVOICE_ID, ...body },
  })
  const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
  return parseJsonResponse<{
    success?: boolean
    invoice_status?: string
    paid_amount?: number
    remaining_amount?: number
    journal_entry_id?: string
    sale_journal_entry_id?: string
    error?: { code: string; details?: Record<string, unknown> }
  }>(response)
}

function expectNothingWritten() {
  expect(mockBookSale).not.toHaveBeenCalled()
  expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  expect(mockCreateInvoiceCashEntry).not.toHaveBeenCalled()
  expect(findCalls('invoices', 'update')).toHaveLength(0)
  expect(findCalls('invoice_payments', 'insert')).toHaveLength(0)
  expect(findCalls('transactions', 'update')).toHaveLength(0)
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  mockFindUnresolvableAccounts.mockResolvedValue([])
  mockFindFiscalPeriod.mockResolvedValue('fp-1')
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-payment' })
  mockCancelOrphanedEntry.mockResolvedValue({ error: null })
  mockPlanSale.mockResolvedValue(NOT_REQUIRED)
  mockBookSale.mockResolvedValue(NOTHING_BOOKED)
})

describe('POST /api/transactions/[id]/match-invoice: the sale first (defer_invoice_booking)', () => {
  it('books the sale first, then clears 1510 with the payment, and names the sale', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    enqueueReads()
    enqueueSettleWrites()

    const { status, body } = await post()

    expect(status).toBe(200)
    expect(body.invoice_status).toBe('paid')
    expect(body.journal_entry_id).toBe('je-payment')
    expect(body.sale_journal_entry_id).toBe('je-sale')
    // Planned on the payment date: the bank row's date.
    expect(mockPlanSale).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      expect.objectContaining({ id: INVOICE_ID, journal_entry_id: null }),
      { settlementDate: '2024-06-15' },
    )
    expect(mockBookSale).toHaveBeenCalledWith(expect.anything(), REQUIRED_PLAN)
    expect(mockBookSale.mock.invocationCallOrder[0]).toBeLessThan(mockCreateJournalEntry.mock.invocationCallOrder[0])
    // The payment is the plain clearing against the receivable the sale booked.
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      source_type: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.source_type).toBe('invoice_paid')
    expect(input.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '1930', debit_amount: 12500 }),
        expect.objectContaining({ account_number: '1510', credit_amount: 12500 }),
      ]),
    )
    expect(input.lines.some((l) => l.account_number.startsWith('30') || l.account_number.startsWith('26'))).toBe(false)
  })

  it('clears what the sale will leave on 1510, off its dry run: no voucher holds it yet', async () => {
    mockPlanSale.mockResolvedValue(FOREIGN_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    vi.mocked(fetchExchangeRate).mockResolvedValue({ currency: 'EUR', rate: 11.123, date: '2024-06-15' })
    enqueueReads({ tx: { amount: 1965.43, currency: 'SEK' }, invoice: FOREIGN_INVOICE })
    enqueueSettleWrites()

    const { status, body } = await post()

    expect(status).toBe(200)
    expect(body.invoice_status).toBe('paid')
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '1930', debit_amount: 1965.43 }),
        expect.objectContaining({ account_number: '1510', credit_amount: 1965.44 }),
        expect.objectContaining({ account_number: '7960', debit_amount: 0.01 }),
      ]),
    )
  })

  it('re-attaches the invoice PDF from the sale verifikat booked first', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    enqueueReads()
    enqueueSettleWrites({ invoicePdf: true })

    const { status } = await post()

    expect(status).toBe(200)
    const lookup = findCalls('document_attachments', 'eq')
    expect(lookup).toContainEqual(['journal_entry_id', 'je-sale'])
    expect(findCalls('document_attachments', 'insert').at(-1)?.[0]).toMatchObject({ journal_entry_id: 'je-payment' })
  })

  it('a partial payment books the whole sale, then the partial clearing', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    enqueueReads({ tx: { amount: 5000 } })
    enqueueSettleWrites()

    const { status, body } = await post()

    expect(status).toBe(200)
    expect(body.invoice_status).toBe('partially_paid')
    expect(body.paid_amount).toBe(5000)
    expect(body.remaining_amount).toBe(7500)
    expect(mockBookSale).toHaveBeenCalledTimes(1)
    const input = mockCreateJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    expect(input.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '1930', debit_amount: 5000 }),
        expect.objectContaining({ account_number: '1510', credit_amount: 5000 }),
      ]),
    )
    expect(mockBookSale.mock.invocationCallOrder[0]).toBeLessThan(mockCreateJournalEntry.mock.invocationCallOrder[0])
  })

  it('refuses with the Bokför code and writes nothing when the plan refuses', async () => {
    mockPlanSale.mockResolvedValue(INVOICE_DATE_LOCKED)
    enqueueReads()

    const { status, body } = await post()

    expect(status).toBe(400)
    expect(body.error?.code).toBe('PERIOD_LOCKED')
    expect(body.error?.details).toMatchObject({ sale_first: true, invoice_date: '2024-06-01' })
    expectNothingWritten()
  })

  it('refuses with the Bokför code and writes nothing when booking the sale is refused', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue({
      ok: false,
      code: 'INVOICE_BOOK_INVALID_STATUS',
      details: { currentStatus: 'partially_paid', sale_first: true, invoice_id: INVOICE_ID },
    })
    enqueueReads()

    const { status, body } = await post()

    expect(status).toBe(400)
    expect(body.error?.code).toBe('INVOICE_BOOK_INVALID_STATUS')
    expect(body.error?.details).toMatchObject({ sale_first: true })
    expect(mockBookSale).toHaveBeenCalledTimes(1)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toHaveLength(0)
    expect(findCalls('invoice_payments', 'insert')).toHaveLength(0)
    expect(findCalls('transactions', 'update')).toHaveLength(0)
  })

  it('names the sale in posted_ids when the payment verifikat then fails', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    mockCreateJournalEntry.mockRejectedValue(new Error('boom'))
    enqueueReads()

    const { status, body } = await post()

    expect(status).toBe(500)
    expect(body.error?.code).toBe('INVOICE_PAID_BOOK_FAILED')
    expect(body.error?.details?.posted_ids).toEqual({ sale_journal_entry_id: 'je-sale' })
    expect(findCalls('invoices', 'update')).toHaveLength(0)
  })

  it('an already booked invoice (plan: not required) pays as before, with no sale named', async () => {
    enqueueReads({ invoice: { journal_entry_id: 'je-invoice' } })
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // row claim
    enqueue({ data: [{ id: INVOICE_ID }], error: null }) // invoice CAS update
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: null, error: null }) // transaction link

    const { status, body } = await post()

    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-payment')
    expect(body).not.toHaveProperty('sale_journal_entry_id')
    expect(mockPlanSale).toHaveBeenCalledTimes(1)
    expect(findCalls('document_attachments', 'eq')).toContainEqual(['journal_entry_id', 'je-invoice'])
  })

  it('kontantmetoden (plan: not required) books the cash entry as before', async () => {
    mockCreateInvoiceCashEntry.mockResolvedValue({ id: 'je-cash' })
    enqueueReads({ method: 'cash' })
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // row claim
    enqueue({ data: [{ id: INVOICE_ID }], error: null }) // invoice CAS update
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: null, error: null }) // transaction link

    const { status, body } = await post()

    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-cash')
    expect(body).not.toHaveProperty('sale_journal_entry_id')
    expect(mockCreateInvoiceCashEntry).toHaveBeenCalledTimes(1)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('edited rows that book the revenue themselves (no 151x credit) skip the plan', async () => {
    enqueueReads()
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // row claim
    enqueue({ data: [{ id: INVOICE_ID }], error: null }) // invoice CAS update
    enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
    enqueue({ data: null, error: null }) // transaction link

    const { status, body } = await post({
      lines: [
        { account_number: '1930', debit_amount: 12500, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 10000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
      ],
    })

    expect(status).toBe(200)
    expect(mockPlanSale).not.toHaveBeenCalled()
    expect(body).not.toHaveProperty('sale_journal_entry_id')
  })

  it('edited rows that clear 1510 still book the sale first', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    mockBookSale.mockResolvedValue(BOOKED)
    enqueueReads()
    enqueueSettleWrites()

    const { status, body } = await post({
      lines: [
        { account_number: '1930', debit_amount: 12500, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 12500 },
      ],
    })

    expect(status).toBe(200)
    expect(mockPlanSale).toHaveBeenCalledTimes(1)
    expect(body.sale_journal_entry_id).toBe('je-sale')
    expect(mockBookSale.mock.invocationCallOrder[0]).toBeLessThan(mockCreateJournalEntry.mock.invocationCallOrder[0])
  })
})

describe('GET /api/transactions/[id]/match-invoice/preview: the sale first', () => {
  function enqueuePreviewReads(opts: { tx?: Record<string, unknown>; invoice?: Record<string, unknown> } = {}) {
    enqueue({ data: makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null, date: '2024-06-15', ...opts.tx }), error: null })
    enqueue({ data: { ...sentInvoice(opts.invoice), items: [] }, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: [], error: null }) // cash accounts -> 1930
  }

  async function preview() {
    const response = await GET(
      createMockRequest('/api/transactions/tx-1/match-invoice/preview', { searchParams: { invoice_id: INVOICE_ID } }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    return parseJsonResponse<{
      lines?: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
      books_sale_first?: boolean
      sale_entry?: unknown
      error?: { code: string; details?: Record<string, unknown> }
    }>(response)
  }

  it('shows the sale verifikat above the payment that clears it', async () => {
    mockPlanSale.mockResolvedValue(REQUIRED_PLAN)
    enqueuePreviewReads()

    const { status, body } = await preview()

    expect(status).toBe(200)
    expect(body.books_sale_first).toBe(true)
    expect(body.sale_entry).toEqual(SALE_ENTRY)
    expect(mockPlanSale).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      expect.objectContaining({ id: INVOICE_ID }),
      { settlementDate: '2024-06-15' },
    )
    expect(body.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '1930', debit_amount: 12500 }),
        expect.objectContaining({ account_number: '1510', credit_amount: 12500 }),
      ]),
    )
    // A preview writes nothing, the sale included.
    expect(mockBookSale).not.toHaveBeenCalled()
  })

  it('shows what the sale will leave on 1510, as the POST clears it', async () => {
    mockPlanSale.mockResolvedValue(FOREIGN_PLAN)
    vi.mocked(fetchExchangeRate).mockResolvedValue({ currency: 'EUR', rate: 11.123, date: '2024-06-15' })
    enqueuePreviewReads({ tx: { amount: 1965.43, currency: 'SEK' }, invoice: FOREIGN_INVOICE })

    const { status, body } = await preview()

    expect(status).toBe(200)
    expect(body.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '1930', debit_amount: 1965.43 }),
        expect.objectContaining({ account_number: '1510', credit_amount: 1965.44 }),
        expect.objectContaining({ account_number: '7960', debit_amount: 0.01 }),
      ]),
    )
  })

  it('answers the refusal the POST would answer', async () => {
    mockPlanSale.mockResolvedValue(INVOICE_DATE_LOCKED)
    enqueuePreviewReads()

    const { status, body } = await preview()

    expect(status).toBe(400)
    expect(body.error?.code).toBe('PERIOD_LOCKED')
    expect(body.error?.details).toMatchObject({ sale_first: true })
  })

  it('says no sale is booked first when none is required', async () => {
    enqueuePreviewReads({ invoice: { journal_entry_id: 'je-invoice' } })

    const { status, body } = await preview()

    expect(status).toBe(200)
    expect(body.books_sale_first).toBe(false)
    expect(body.sale_entry).toBeNull()
  })
})
