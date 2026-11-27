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
vi.mock('@/lib/bookkeeping/accruals/from-invoices', async (importOriginal) => ({
  ACCRUAL_RELEASE_FAILED_WARNING: (await importOriginal<typeof import('@/lib/bookkeeping/accruals/from-invoices')>())
    .ACCRUAL_RELEASE_FAILED_WARNING,
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

/** A completed email delivery that archived the PDF it sent, as the summary readers list it. */
function sentDelivery(documentId: string, sentAt: string) {
  return { id: `delivery-${documentId}`, status: 'sent', document_attachment_id: documentId, sent_at: sentAt }
}

/** What the session's reader answers when there is no auth.uid(), as on the service role. */
const SESSION_REFUSAL = { code: '42501', message: 'not authorized to list invoice delivery summaries' }

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
    enqueue({ data: [sentDelivery('document-1', '2026-11-25T16:33:41+00:00')], error: null }) // the session's delivery history

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
      { posting: expect.any(Function) }, // what the door saw, read by the posting port only while POSTING_EVENTS is on
    )
    expect(mockLinkToJournalEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'document-1',
      'je-1',
      { link_basis: 'system_derived', link_evidence: null },
    )
    expect(mockSupabase.rpc).toHaveBeenCalledWith('list_invoice_delivery_summaries', {
      p_company_id: 'company-1',
      p_invoice_id: 'inv-1',
    })
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('list_invoice_delivery_summaries_for_service', expect.anything())
    expect(mockCreateSchedules).toHaveBeenCalled()
  })

  // The MCP, v1 and grant doors book on the service role, where auth.uid() is
  // null: the session's reader refuses (42501) and the emailed PDF used to be
  // left off the verifikat with a PDF_LINK_FAILED warning.
  it('links the delivered PDF when the booking runs on the service role', async () => {
    const invoice = makeSentInvoice()
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: { ...invoice, journal_entry_id: 'je-1' }, error: null }) // CAS link
    enqueue({ data: null, error: SESSION_REFUSAL }) // the session's reader: no auth.uid()
    enqueue({
      // Newest first, as the reader lists them: a later manual mark keeps no
      // file, so the emailed copy is the one the verifikat gets.
      data: [
        { id: 'delivery-3', status: 'marked_sent', document_attachment_id: null, sent_at: '2026-11-26T09:00:00+00:00' },
        sentDelivery('document-2', '2026-11-25T16:33:41+00:00'),
        { id: 'delivery-x', status: 'failed', document_attachment_id: null, sent_at: null },
        sentDelivery('document-1', '2026-11-20T08:00:00+00:00'),
      ],
      error: null,
    })

    const result = await book(invoice)

    expect(result).toEqual(expect.objectContaining({ ok: true, journalEntryId: 'je-1', warnings: [] }))
    expect(mockSupabase.rpc).toHaveBeenCalledWith('list_invoice_delivery_summaries_for_service', {
      p_company_id: 'company-1',
      p_user_id: 'user-1',
      p_invoice_id: 'inv-1',
    })
    expect(mockLinkToJournalEntry).toHaveBeenCalledTimes(1)
    expect(mockLinkToJournalEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'document-2',
      'je-1',
      { link_basis: 'system_derived', link_evidence: null },
    )
  })

  it('books and warns when neither reader can read the delivery history', async () => {
    const invoice = makeSentInvoice()
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: { ...invoice, journal_entry_id: 'je-1' }, error: null }) // CAS link
    enqueue({ data: null, error: SESSION_REFUSAL })
    // A session has no EXECUTE on the service sibling.
    enqueue({
      data: null,
      error: { code: '42501', message: 'permission denied for function list_invoice_delivery_summaries_for_service' },
    })

    const result = await book(invoice)

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        journalEntryId: 'je-1',
        warnings: [expect.objectContaining({ code: 'PDF_LINK_FAILED' })],
      }),
    )
    expect(mockLinkToJournalEntry).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(
      'failed to find delivered invoice PDF for deferred booking',
      SESSION_REFUSAL,
      expect.objectContaining({ invoiceId: 'inv-1', serviceReadCode: '42501' }),
    )
  })

  it('links nothing and warns nothing when no delivery kept a file', async () => {
    const invoice = makeSentInvoice()
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: { ...invoice, journal_entry_id: 'je-1' }, error: null }) // CAS link
    enqueue({ data: null, error: SESSION_REFUSAL })
    enqueue({
      data: [{ id: 'delivery-1', status: 'marked_sent', document_attachment_id: null, sent_at: '2026-11-25T16:33:40+00:00' }],
      error: null,
    })

    const result = await book(invoice)

    expect(result).toEqual(expect.objectContaining({ ok: true, warnings: [] }))
    expect(mockLinkToJournalEntry).not.toHaveBeenCalled()
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

  it('warns when an upplupen intäkt month could not post right after the booking (#62)', async () => {
    const invoice = makeSentInvoice()
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: { ...invoice, journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: null, error: null }) // no delivered PDF found
    mockCreateSchedules.mockResolvedValue({ created: 1, failed: 0, releasesFailed: 1 })

    const result = await book(invoice)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: 'ACCRUAL_RELEASE_FAILED', message: expect.stringMatching(/Bokför förfallna/) }),
      ])
    }
  })
})
