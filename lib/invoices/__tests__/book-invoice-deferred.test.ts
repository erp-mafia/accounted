import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeInvoice } from '@/tests/helpers'
import { FiscalPeriodNotFoundError } from '@/lib/bookkeeping/errors'
import type { Logger } from '@/lib/logger'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const mockCreateInvoiceJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: (...args: unknown[]) =>
    mockCreateInvoiceJournalEntry(...args),
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

import { bookInvoiceDeferred, INVOICE_BOOKABLE_STATUSES } from '../book-invoice-deferred'

const log: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => log,
}

function makeSentInvoice(overrides: Record<string, unknown> = {}) {
  return {
    ...makeInvoice({ id: 'inv-1', status: 'sent' }),
    journal_entry_id: null,
    credited_invoice_id: null,
    document_type: 'invoice' as const,
    customer: { name: 'Kunden AB' },
    items: [],
    ...overrides,
  }
}

function book(invoice = makeSentInvoice()) {
  return bookInvoiceDeferred({
    supabase: mockSupabase as never,
    companyId: 'company-1',
    userId: 'user-1',
    invoice: invoice as never,
    entityType: 'aktiebolag',
    log,
  })
}

describe('bookInvoiceDeferred', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockCreateSchedules.mockResolvedValue({ created: 0, failed: 0 })
    mockLinkToJournalEntry.mockResolvedValue({ id: 'document-1' })
  })

  it('exports the bookable statuses the routes guard on', () => {
    expect(INVOICE_BOOKABLE_STATUSES).toEqual(['sent', 'overdue'])
  })

  it('books the revenue entry, claims the invoice and links the delivered PDF', async () => {
    const invoice = makeSentInvoice()
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: { ...invoice, journal_entry_id: 'je-1' }, error: null }) // CAS link
    enqueue({ data: 'document-1', error: null }) // delivery-document rpc

    const result = await book(invoice)

    expect(result).toEqual({
      ok: true,
      invoice: expect.objectContaining({ journal_entry_id: 'je-1' }),
      journalEntryId: 'je-1',
      warnings: [],
    })
    expect(mockCreateInvoiceJournalEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      'aktiebolag',
      'Kunden AB',
    )
    expect(mockLinkToJournalEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'document-1',
      'je-1',
    )
    expect(mockCreateSchedules).toHaveBeenCalled()
  })

  it('returns INVOICE_BOOK_NO_FISCAL_PERIOD when no period covers the date', async () => {
    mockCreateInvoiceJournalEntry.mockResolvedValue(null)

    const result = await book()

    expect(result).toEqual({
      ok: false,
      kind: 'code',
      errorCode: 'INVOICE_BOOK_NO_FISCAL_PERIOD',
      details: { invoiceDate: '2024-06-15' },
    })
  })

  it('cancels the orphaned entry and reports a conflict when the CAS claim loses', async () => {
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: null, error: { message: 'no rows' } }) // CAS link fails

    const result = await book()

    expect(result).toEqual({ ok: false, kind: 'code', errorCode: 'INVOICE_BOOK_CONFLICT' })
    expect(mockCancelOrphan).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
    )
  })

  it('passes typed bookkeeping errors through as domain failures', async () => {
    const domainError = new FiscalPeriodNotFoundError()
    mockCreateInvoiceJournalEntry.mockRejectedValue(domainError)

    const result = await book()

    expect(result).toEqual({ ok: false, kind: 'domain', error: domainError })
    expect(mockCancelOrphan).not.toHaveBeenCalled()
  })

  it('maps unknown engine failures to INVOICE_BOOK_FAILED', async () => {
    mockCreateInvoiceJournalEntry.mockRejectedValue(new Error('network down'))

    const result = await book()

    expect(result).toEqual({ ok: false, kind: 'code', errorCode: 'INVOICE_BOOK_FAILED' })
  })

  it('reports accrual-schedule failures as warnings, not errors', async () => {
    const invoice = makeSentInvoice()
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: { ...invoice, journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: null, error: null }) // no delivered PDF found
    mockCreateSchedules.mockResolvedValue({ created: 0, failed: 1 })

    const result = await book(invoice)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: 'ACCRUAL_SCHEDULE_FAILED' }),
      ])
    }
  })
})
