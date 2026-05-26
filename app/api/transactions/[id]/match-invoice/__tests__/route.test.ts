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

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

const mockCreateInvoicePaymentJournalEntry = vi.fn()
const mockCreateInvoiceCashEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: (...args: unknown[]) => mockCreateInvoicePaymentJournalEntry(...args),
  createInvoiceCashEntry: (...args: unknown[]) => mockCreateInvoiceCashEntry(...args),
  getRevenueAccount: vi.fn().mockReturnValue('3001'),
  getOutputVatAccount: vi.fn().mockReturnValue('2611'),
}))

const mockReverseEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
}))

vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(),
}))

const mockDetectDuplicate = vi.fn()
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: (...args: unknown[]) => mockDetectDuplicate(...args),
}))

vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn() },
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

import { POST } from '../route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_UUID_2 = '550e8400-e29b-41d4-a716-446655440001'
const CANDIDATE_UUID = '550e8400-e29b-41d4-a716-446655440003'
const STALE_UUID = '550e8400-e29b-41d4-a716-446655440004'
const OTHER_CANDIDATE_UUID = '550e8400-e29b-41d4-a716-446655440005'

describe('POST /api/transactions/[id]/match-invoice', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    // Default to no soft-duplicate detected — happy-path tests don't care.
    mockDetectDuplicate.mockResolvedValue(null)
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when invoice_id is missing', async () => {
    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Validation failed')
  })

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/transactions/tx-999/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-999' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('returns 400 when transaction is an expense (amount <= 0)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: -500 })
    enqueue({ data: tx, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_NOT_INCOME')
  })

  it('returns 400 when transaction is already linked to an invoice', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: 'inv-other' })
    enqueue({ data: tx, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_TX_ALREADY_LINKED')
  })

  it('returns 404 when invoice not found', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null })
    enqueue({ data: tx, error: null })
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID_2 },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_NOT_FOUND')
  })

  it('returns 400 when matching against a proforma (defense-in-depth)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null })
    const proforma = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      document_type: 'proforma',
    } as Parameters<typeof makeInvoice>[0])
    enqueue({ data: tx, error: null })
    enqueue({ data: proforma, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_NOT_INVOICE_TYPE')
  })

  it('returns 400 when invoice is not in unpaid state', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'paid' })
    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_NOT_OPEN')
  })

  it('matches transaction to invoice with accrual method (full payment)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null, date: '2024-06-15' })
    const customer = makeCustomer()
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
      subtotal: 10000,
      vat_amount: 2500,
      invoice_number: 'F-2024001',
      customer,
    })

    // Fetch transaction
    enqueue({ data: tx, error: null })
    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Hard-duplicate check: no prior payment voucher for this invoice
    enqueue({ data: [], error: null })
    // Fetch company settings
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Update invoice (optimistic lock returns updated row)
    enqueue({ data: [{ id: VALID_UUID }], error: null })
    // Insert invoice_payments
    enqueue({ data: null, error: null })
    // Update transaction
    enqueue({ data: null, error: null })
    // logMatchEvent insert (fire-and-forget)
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      invoice_status: string
      paid_amount: number
      remaining_amount: number
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.invoice_status).toBe('paid')
    expect(body.paid_amount).toBe(12500)
    expect(body.remaining_amount).toBe(0)
    expect(body.journal_entry_id).toBe('je-1')

    // Verify accrual payment entry was called with paymentAmount
    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: VALID_UUID }),
      '2024-06-15',
      undefined,
      expect.anything(),
      12500
    )
  })

  it('stornos conflicting journal entry before matching', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 12500,
      invoice_id: null,
      journal_entry_id: 'je-conflict',
      date: '2024-06-15',
    })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
    })

    // Fetch transaction
    enqueue({ data: tx, error: null })
    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Hard-duplicate check: no prior payment voucher for this invoice
    enqueue({ data: [], error: null })

    mockReverseEntry.mockResolvedValue({ id: 'je-storno' })
    // Clear journal_entry_id on transaction
    enqueue({ data: null, error: null })
    // logMatchEvent for storno
    enqueue({ data: null, error: null })

    // Fetch company settings
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-payment' })

    // Update invoice (optimistic lock)
    enqueue({ data: [{ id: VALID_UUID }], error: null })
    // Insert invoice_payments
    enqueue({ data: null, error: null })
    // Update transaction
    enqueue({ data: null, error: null })
    // logMatchEvent for match
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_id: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-payment')
    expect(mockReverseEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'je-conflict')
  })

  it('returns 500 when storno fails — no partial state change', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 12500,
      invoice_id: null,
      journal_entry_id: 'je-conflict',
    })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'sent', remaining_amount: 12500 })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    // Hard-duplicate check: no prior payment voucher
    enqueue({ data: [], error: null })

    mockReverseEntry.mockRejectedValue(new Error('Period locked'))

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    // Storno failures bubble up through the bookkeeping engine; the wrapper
    // routes any non-typed error to INTERNAL_ERROR.
    expect((body.error as unknown as { code: string }).code).toBe('INTERNAL_ERROR')
    // Invoice should NOT have been updated — no further DB calls after storno failure
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('supports partial payment (partially_paid status)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 5000, invoice_id: null, date: '2024-06-15' })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
      paid_amount: 0,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-partial' })

    // Update invoice (optimistic lock)
    enqueue({ data: [{ id: VALID_UUID }], error: null })
    // Insert invoice_payments
    enqueue({ data: null, error: null })
    // Update transaction
    enqueue({ data: null, error: null })
    // logMatchEvent
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      invoice_status: string
      paid_amount: number
      remaining_amount: number
    }>(response)

    expect(status).toBe(200)
    expect(body.invoice_status).toBe('partially_paid')
    expect(body.paid_amount).toBe(5000)
    expect(body.remaining_amount).toBe(7500)
  })

  it('cash method partial payment uses clearing entry with note', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 5000, invoice_id: null, date: '2024-06-15' })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
      paid_amount: 0,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-clearing' })

    // Update invoice
    enqueue({ data: [{ id: VALID_UUID }], error: null })
    // Insert invoice_payments
    enqueue({ data: null, error: null })
    // Update transaction
    enqueue({ data: null, error: null })
    // logMatchEvent
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ invoice_status: string }>(response)

    expect(status).toBe(200)
    expect(body.invoice_status).toBe('partially_paid')
    // Cash partial uses accrual-style clearing entry, NOT createInvoiceCashEntry
    expect(mockCreateInvoicePaymentJournalEntry).toHaveBeenCalled()
    expect(mockCreateInvoiceCashEntry).not.toHaveBeenCalled()
  })

  it('returns 409 when invoice is fully paid (optimistic lock)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Optimistic lock returns 0 rows (another request fully paid it)
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_ALREADY_PAID')
  })

  it('returns 409 on duplicate invoice_payment (unique constraint)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Optimistic lock succeeds
    enqueue({ data: [{ id: VALID_UUID }], error: null })
    // invoice_payments insert fails with unique constraint violation
    enqueue({ data: null, error: { code: '23505', message: 'duplicate' } })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    expect((body.error as unknown as { code: string }).code).toBe('MATCH_INVOICE_DUPLICATE_PAYMENT')
  })

  it('returns success with journal_entry_error when journal entry fails (non-blocking)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null, date: '2024-06-15' })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'sent', total: 12500, remaining_amount: 12500 })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })

    mockCreateInvoicePaymentJournalEntry.mockRejectedValue(new Error('Period locked'))

    // Update invoice (optimistic lock)
    enqueue({ data: [{ id: VALID_UUID }], error: null })
    // Insert invoice_payments
    enqueue({ data: null, error: null })
    // Update transaction
    enqueue({ data: null, error: null })
    // logMatchEvent
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: null
      journal_entry_error: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBeNull()
    expect(body.journal_entry_error).toBe('Period locked')
  })

  // ────────────────────────────────────────────────────────────────
  // Duplicate-payment guards (Phase A4)
  // ────────────────────────────────────────────────────────────────

  it('returns 409 MATCH_INVOICE_ALREADY_HAS_PAYMENT_VOUCHER when a payment row already links a JE for a sent invoice', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500, invoice_id: null })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 12500,
      remaining_amount: 12500,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    // Hard-duplicate check returns a row pointing at the existing JE
    enqueue({ data: [{ journal_entry_id: 'je-existing' }], error: null })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details?: { existing_journal_entry_id?: string } } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('MATCH_INVOICE_ALREADY_HAS_PAYMENT_VOUCHER')
    expect(body.error.details?.existing_journal_entry_id).toBe('je-existing')
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('does NOT run hard-duplicate guard for partially_paid invoices (legitimate additional payment)', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 2500, invoice_id: null, date: '2024-06-15' })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'partially_paid',
      total: 12500,
      remaining_amount: 2500,
      paid_amount: 10000,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    // Hard-duplicate check is skipped for partially_paid; jump straight to settings
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-partial-extra' })
    enqueue({ data: [{ id: VALID_UUID }], error: null }) // update invoice
    enqueue({ data: null, error: null }) // insert invoice_payments
    enqueue({ data: null, error: null }) // update tx
    enqueue({ data: null, error: null }) // logMatchEvent

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; invoice_status: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.invoice_status).toBe('paid')
  })

  it('returns 409 MATCH_INVOICE_POSSIBLE_DUPLICATE when the soft-duplicate detector finds a manual voucher', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 1000, invoice_id: null, date: '2026-05-15' })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'sent', total: 1000, remaining_amount: 1000 })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check: clean

    mockDetectDuplicate.mockResolvedValueOnce({
      journal_entry_id: 'je-manual',
      voucher_label: 'A12',
      entry_date: '2026-05-15',
      description: 'Inbetalning faktura',
      amount: 1000,
      bank_account_number: '1930',
      reason: 'exact_amount_same_date',
    })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { candidate?: { journal_entry_id: string; voucher_label: string } } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('MATCH_INVOICE_POSSIBLE_DUPLICATE')
    expect(body.error.details?.candidate?.journal_entry_id).toBe('je-manual')
    expect(body.error.details?.candidate?.voucher_label).toBe('A12')
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('force=true bypasses the soft-duplicate guard when the candidate echo matches', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 1000, invoice_id: null, date: '2026-05-15' })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      total: 1000,
      remaining_amount: 1000,
      invoice_number: 'F-2024099',
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check: clean

    // force=true re-detects the candidate to verify the echoed id matches.
    mockDetectDuplicate.mockResolvedValueOnce({
      journal_entry_id: CANDIDATE_UUID,
      voucher_label: 'A12',
      entry_date: '2026-05-15',
      description: 'Inbetalning faktura',
      amount: 1000,
      bank_account_number: '1930',
      reason: 'exact_amount_same_date',
    })

    enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })

    mockCreateInvoicePaymentJournalEntry.mockResolvedValue({ id: 'je-forced' })
    enqueue({ data: [{ id: VALID_UUID }], error: null }) // update invoice
    enqueue({ data: null, error: null }) // insert invoice_payments
    enqueue({ data: null, error: null }) // update tx
    enqueue({ data: null, error: null }) // logMatchEvent

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID, force: true, expected_journal_entry_id: CANDIDATE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_id: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-forced')
    expect(mockDetectDuplicate).toHaveBeenCalledTimes(1)
  })

  it('returns 400 when force=true is sent without expected_journal_entry_id', async () => {
    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID, force: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)
    // Refusal happens at the schema layer (refine) before any DB work.
    expect(status).toBe(400)
  })

  it('returns 409 MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH when the echoed candidate no longer matches', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 1000, invoice_id: null, date: '2026-05-15' })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'sent', total: 1000, remaining_amount: 1000 })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check: clean

    // Re-detection returns a different candidate than the caller echoed.
    mockDetectDuplicate.mockResolvedValueOnce({
      journal_entry_id: OTHER_CANDIDATE_UUID,
      voucher_label: 'A99',
      entry_date: '2026-05-15',
      description: 'Annan verifikation',
      amount: 1000,
      bank_account_number: '1930',
      reason: 'exact_amount_same_date',
    })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID, force: true, expected_journal_entry_id: STALE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { expected_journal_entry_id?: string; detected_journal_entry_id?: string } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH')
    expect(body.error.details?.expected_journal_entry_id).toBe(STALE_UUID)
    expect(body.error.details?.detected_journal_entry_id).toBe(OTHER_CANDIDATE_UUID)
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 409 MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH when no current duplicate exists for the force call', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 1000, invoice_id: null, date: '2026-05-15' })
    const invoice = makeInvoice({ id: VALID_UUID, status: 'sent', total: 1000, remaining_amount: 1000 })

    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: [], error: null }) // hard-duplicate check: clean

    // Detection returns null — the duplicate the caller saw has resolved.
    mockDetectDuplicate.mockResolvedValueOnce(null)

    const request = createMockRequest('/api/transactions/tx-1/match-invoice', {
      method: 'POST',
      body: { invoice_id: VALID_UUID, force: true, expected_journal_entry_id: STALE_UUID },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH')
    expect(mockCreateInvoicePaymentJournalEntry).not.toHaveBeenCalled()
  })
})
