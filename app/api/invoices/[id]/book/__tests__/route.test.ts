import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeInvoice,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockCreateInvoiceJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: (...args: unknown[]) => mockCreateInvoiceJournalEntry(...args),
}))

const mockCreateSchedules = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/from-invoices', () => ({
  createSchedulesForCustomerInvoice: (...args: unknown[]) => mockCreateSchedules(...args),
}))

const mockCancelOrphan = vi.fn()
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: (...args: unknown[]) => mockCancelOrphan(...args),
}))

const mockLinkToJournalEntry = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: (...args: unknown[]) => mockLinkToJournalEntry(...args),
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function bookRequest() {
  return POST(
    createMockRequest('/api/invoices/inv-1/book', { method: 'POST' }),
    createMockRouteParams({ id: 'inv-1' }),
  )
}

function makeUnbookedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    ...makeInvoice({ id: 'inv-1', status: 'sent' }),
    journal_entry_id: null,
    credited_invoice_id: null,
    document_type: 'invoice',
    customer: { name: 'Kunden AB' },
    items: [],
    ...overrides,
  }
}

describe('POST /api/invoices/[id]/book', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
    mockCreateSchedules.mockResolvedValue({ created: 0, failed: 0 })
    mockLinkToJournalEntry.mockResolvedValue({ id: 'document-1' })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const { status } = await parseJsonResponse(await bookRequest())
    expect(status).toBe(401)
  })

  it('returns 404 when the invoice does not exist', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_NOT_FOUND')
  })

  it('rejects an already booked invoice', async () => {
    enqueue({ data: makeUnbookedInvoice({ journal_entry_id: 'je-existing' }), error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_BOOK_ALREADY_BOOKED')
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects credit notes', async () => {
    enqueue({ data: makeUnbookedInvoice({ credited_invoice_id: 'inv-0' }), error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_BOOK_NOT_BOOKABLE')
  })

  it('rejects paid invoices (payment flow already booked them)', async () => {
    enqueue({ data: makeUnbookedInvoice({ status: 'paid' }), error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_BOOK_INVALID_STATUS')
  })

  it('fails closed when company settings cannot be read', async () => {
    enqueue({ data: makeUnbookedInvoice(), error: null })
    enqueue({ data: null, error: { message: 'boom' } })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(500)
    expect(body.error.code).toBe('INVOICE_BOOK_FAILED')
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects booking under the cash method', async () => {
    enqueue({ data: makeUnbookedInvoice(), error: null })
    enqueue({ data: { accounting_method: 'cash', entity_type: 'aktiebolag' }, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_BOOK_CASH_METHOD')
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when no fiscal period covers the invoice date', async () => {
    enqueue({ data: makeUnbookedInvoice(), error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null })
    mockCreateInvoiceJournalEntry.mockResolvedValue(null)

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_BOOK_NO_FISCAL_PERIOD')
  })

  it('cancels the entry and returns 409 when another request booked first', async () => {
    enqueue({ data: makeUnbookedInvoice(), error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
    // CAS-guarded link matches no row: someone else already claimed it.
    enqueue({ data: null, error: { message: 'no rows' } })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await bookRequest())
    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_BOOK_CONFLICT')
    expect(mockCancelOrphan).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
    )
  })

  it('books the revenue entry and links it', async () => {
    const invoice = makeUnbookedInvoice()
    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: { ...invoice, journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: null, error: null })

    const { status, body } = await parseJsonResponse<{
      data: { journal_entry_id: string }
      journal_entry_id: string
    }>(await bookRequest())

    expect(status).toBe(200)
    expect(body.journal_entry_id).toBe('je-1')
    expect(body.data.journal_entry_id).toBe('je-1')
    expect(mockCreateInvoiceJournalEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      'aktiebolag',
      'Kunden AB',
    )
    expect(mockCreateSchedules).toHaveBeenCalled()
  })

  it('links the delivered PDF to the deferred journal entry', async () => {
    const invoice = makeUnbookedInvoice()
    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: { ...invoice, journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: 'document-1', error: null })

    const { status } = await parseJsonResponse(await bookRequest())

    expect(status).toBe(200)
    expect(mockLinkToJournalEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'document-1',
      'je-1',
    )
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'latest_sent_invoice_delivery_document',
      { p_company_id: 'company-1', p_invoice_id: 'inv-1' },
    )
  })
})
