import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockCreateInvoicePaymentJournalEntry = vi.fn()
const mockCreateInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: (...args: unknown[]) =>
    mockCreateInvoicePaymentJournalEntry(...args),
  createInvoiceCashEntry: (...args: unknown[]) =>
    mockCreateInvoiceCashEntry(...args),
}))

const mockCreateJournalEntry = vi.fn()
const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) =>
    mockCreateJournalEntry(...args),
  findFiscalPeriod: (...args: unknown[]) =>
    mockFindFiscalPeriod(...args),
}))

import { POST } from '../route'

describe('POST /api/invoices/[id]/mark-paid', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when invoice not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_FOUND')
  })

  it('returns 400 when invoice is in draft status', async () => {
    const invoice = makeInvoice({ status: 'draft' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_PAYABLE')
  })

  it('returns 400 when invoice is already paid', async () => {
    const invoice = makeInvoice({ status: 'paid' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_PAYABLE')
  })

  it('returns 400 when invoice is credited', async () => {
    const invoice = makeInvoice({ status: 'credited' })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body: _body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
  })

  it('marks sent invoice as paid with accrual method', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 12500,
      customer,
    })

    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: merchant_name ILIKE, no candidates
    enqueue({ data: [], error: null })
    // Duplicate-payment guard: description ILIKE, no candidates
    enqueue({ data: [], error: null })
    // Fetch company settings (now before update due to journal-first ordering)
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-1' })

    const paidHandler = vi.fn()
    eventBus.on('invoice.paid', paidHandler)

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      paid_amount: number
      remaining_amount: number
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.status).toBe('paid')
    expect(body.paid_amount).toBe(12500)
    expect(body.remaining_amount).toBe(0)
    expect(body.journal_entry_id).toBe('je-1')
    // invoice.paid must fire so registered webhooks fan out (issue #825).
    expect(paidHandler).toHaveBeenCalledTimes(1)
    expect(paidHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        userId: 'user-1',
        paymentAmount: 12500,
        invoice: expect.objectContaining({ id: 'inv-1', status: 'paid', paid_amount: 12500, remaining_amount: 0 }),
      }),
    )
    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      expect.any(String),
      undefined,
      expect.anything()
    )
  })

  it('refuses to mark paid (INVOICE_PAID_BOOK_FAILED) when no payment journal entry is produced', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500, customer })

    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: two ILIKE probes, no candidates
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })
    // Company settings
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    // Deliberately NO status-update enqueued: the route must fail closed BEFORE
    // touching the invoice row when nothing was booked.

    // Helper returns null without throwing (e.g. a closed/locked fiscal period).
    mockCreateInvoicePaymentJournalEntry.mockResolvedValue(null)

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalled()
    // No silent "paid with no journal entry": GL must not diverge from the AR ledger.
    expect(body.error.code).toBe('INVOICE_PAID_BOOK_FAILED')
  })

  it('marks overdue invoice as paid with cash method', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'overdue',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: merchant_name ILIKE, no candidates
    enqueue({ data: [], error: null })
    // Duplicate-payment guard: description ILIKE, no candidates
    enqueue({ data: [], error: null })
    enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null })
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockCreateInvoiceCashEntry.mockResolvedValue({ id: 'je-2' })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-2')
    expect(mockCreateInvoiceCashEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      expect.any(String),
      'enskild_firma',
      expect.anything()
    )
  })

  it('returns 500 when journal entry creation fails (invoice not marked paid)', async () => {
    // No customer attached → duplicate guard skips with missing_customer_name
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })

    mockCreateInvoicePaymentJournalEntry.mockRejectedValueOnce(new Error('Period locked'))

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
  })

  it('uses custom lines when provided instead of auto-generating', async () => {
    // No customer attached → duplicate guard skips with missing_customer_name
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Fetch company settings (before update, journal-first ordering)
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockFindFiscalPeriod.mockResolvedValue('fp-1')
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-custom' })

    const customLines = [
      { account_number: '1920', debit_amount: 12500, credit_amount: 0, line_description: 'Betalning' },
      { account_number: '1510', debit_amount: 0, credit_amount: 12500, line_description: 'Betalning' },
    ]

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        payment_date: '2025-03-17',
        lines: customLines,
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-custom')
    // Should NOT call auto-generation functions
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
    expect(mockCreateInvoiceCashEntry).not.toHaveBeenCalled()
    // Should call createJournalEntry directly with custom lines
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        entry_date: '2025-03-17',
        source_type: 'invoice_paid',
        lines: customLines,
      })
    )
  })

  it('returns 400 when custom lines are unbalanced', async () => {
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    // Fetch invoice
    enqueue({ data: invoice, error: null })

    const unbalancedLines = [
      { account_number: '1920', debit_amount: 12500, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 10000 },
    ]

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        payment_date: '2025-03-17',
        lines: unbalancedLines,
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_LINES_UNBALANCED')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when body has invalid schema (e.g. bad account number)', async () => {
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    // Fetch invoice
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: {
        payment_date: '2025-03-17',
        lines: [
          { account_number: 'XXXX', debit_amount: 12500, credit_amount: 0 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('returns 409 INVOICE_PAID_LIKELY_DUPLICATE when an unlinked transaction matches', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: merchant_name ILIKE returns the match
    enqueue({
      data: [
        {
          id: 'tx-99',
          date: '2026-05-10',
          amount: 12500,
          description: 'Inbetalning Test AB',
          merchant_name: 'Test AB',
          reference: null,
        },
      ],
      error: null,
    })
    // description ILIKE, no additional match (dedup keeps merchant_name result)
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ id: string; match_reason: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_PAID_LIKELY_DUPLICATE')
    expect(body.error.details.candidates).toHaveLength(1)
    expect(body.error.details.candidates[0].id).toBe('tx-99')
    expect(body.error.details.candidates[0].match_reason).toBe('name_amount_fuzzy')
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('proceeds when force=true even with candidates present', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    // Guard query is SKIPPED because force=true short-circuits the check
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-force' })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { force: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_id: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-force')
  })

  it('skips duplicate guard on partial payment (lines total < remaining)', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 12500,
      customer,
    })

    // No guard query enqueued: guard is skipped for partial payments
    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockFindFiscalPeriod.mockResolvedValue('fp-1')
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-partial' })

    const partialLines = [
      { account_number: '1930', debit_amount: 5000, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 5000 },
    ]

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { lines: partialLines },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      status: string
      paid_amount: number
      remaining_amount: number
      paid_at: string | null
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-partial')
    // A 5000 payment on a 12500 invoice → partially_paid, remaining 7500.
    expect(body.status).toBe('partially_paid')
    expect(body.paid_amount).toBe(5000)
    expect(body.remaining_amount).toBe(7500)
    expect(body.paid_at).toBeNull()
  })

  it('returns 400 MATCH_AMOUNT_EXCEEDS_REMAINING when custom lines overpay the invoice', async () => {
    // No customer → duplicate guard skips; the overpayment guard must reject
    // BEFORE any journal entry is created (planInvoicePayment runs first).
    const invoice = makeInvoice({ id: 'inv-1', status: 'sent', total: 12500 })

    enqueue({ data: invoice, error: null })

    const overpayLines = [
      { account_number: '1930', debit_amount: 15000, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: 15000 },
    ]

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { lines: overpayLines },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('surfaces ocr_exact match_reason when tx reference normalizes to invoice_number', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      invoice_number: '2026-0042',
      status: 'sent',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    // OCR match: tx.reference '20260042' normalizes to invoice_number '20260042'
    enqueue({
      data: [
        {
          id: 'tx-ocr',
          date: '2026-05-10',
          amount: 12500,
          description: 'Insättning',
          merchant_name: 'Test AB',
          reference: '2026 0042',
        },
      ],
      error: null,
    })
    // description ILIKE, no additional match
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ id: string; match_reason: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_PAID_LIKELY_DUPLICATE')
    expect(body.error.details.candidates[0].match_reason).toBe('ocr_exact')
  })

  it('ranks ocr_exact ahead of name_amount_fuzzy when multiple candidates match', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      invoice_number: '2026-0042',
      status: 'sent',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    enqueue({
      data: [
        // Name+amount only (no OCR)
        {
          id: 'tx-name',
          date: '2026-05-09',
          amount: 12500,
          description: 'Inbetalning Test AB',
          merchant_name: 'Test AB',
          reference: null,
        },
        // OCR exact match
        {
          id: 'tx-ocr',
          date: '2026-05-08',
          amount: 12500,
          description: 'Inbetalning Test AB',
          merchant_name: 'Test AB',
          reference: '2026-0042',
        },
      ],
      error: null,
    })
    // description ILIKE, no additional matches
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ id: string; match_reason: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.details.candidates[0].id).toBe('tx-ocr')
    expect(body.error.details.candidates[0].match_reason).toBe('ocr_exact')
    expect(body.error.details.candidates[1].id).toBe('tx-name')
    expect(body.error.details.candidates[1].match_reason).toBe('name_amount_fuzzy')
  })

  it('falls back to auto-generation when lines are not provided', async () => {
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: 'inv-1',
      status: 'sent',
      total: 12500,
      customer,
    })

    enqueue({ data: invoice, error: null })
    // Duplicate-payment guard: merchant_name ILIKE, no candidates
    enqueue({ data: [], error: null })
    // Duplicate-payment guard: description ILIKE, no candidates
    enqueue({ data: [], error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    // Update invoice status (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-auto' })

    const request = createMockRequest('/api/invoices/inv-1/mark-paid', {
      method: 'POST',
      body: { payment_date: '2025-03-17' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string | null
    }>(response)

    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-auto')
    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })
})
