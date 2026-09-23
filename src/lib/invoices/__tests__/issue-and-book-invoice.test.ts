import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
  makeCompanySettings,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const mockEnsureInvoiceNumber = vi.fn()
vi.mock('@/lib/invoices/ensure-invoice-number', () => ({
  ensureInvoiceNumber: (...args: unknown[]) => mockEnsureInvoiceNumber(...args),
}))

const mockRenderToBuffer = vi.fn()
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: (...args: unknown[]) => mockRenderToBuffer(...args),
  Document: vi.fn(),
  Page: vi.fn(),
  Text: vi.fn(),
  View: vi.fn(),
  StyleSheet: { create: (s: unknown) => s },
}))

vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: vi.fn().mockReturnValue('mock-pdf-element'),
  brandingFromCompanySettings: vi.fn().mockReturnValue({}),
  SHOW_SWISH_ON_INVOICE: false,
}))

const mockCreateInvoiceJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: (...args: unknown[]) =>
    mockCreateInvoiceJournalEntry(...args),
}))

const mockCreateSchedules = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/from-invoices', () => ({
  createSchedulesForCustomerInvoice: (...args: unknown[]) => mockCreateSchedules(...args),
}))

const mockUploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}))

const mockRecordManualInvoiceDelivery = vi.fn()
vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  recordManualInvoiceDelivery: (...args: unknown[]) => mockRecordManualInvoiceDelivery(...args),
}))

import { issueAndBookInvoice } from '../issue-and-book-invoice'
import type { CompanySettings } from '@/types'

const log: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => log,
}

const customer = makeCustomer({ id: 'cust-1' })
const settings = makeCompanySettings({
  accounting_method: 'accrual',
  entity_type: 'enskild_firma',
  bankgiro: '123-4567',
}) as CompanySettings

function makeDraft(overrides: Record<string, unknown> = {}) {
  return {
    ...makeInvoice({ id: 'inv-1', invoice_number: 'F-2026010', status: 'draft' }),
    document_type: 'invoice' as const,
    credited_invoice_id: null,
    customer,
    items: [],
    ...overrides,
  }
}

function issue(invoice = makeDraft(), theSettings = settings) {
  return issueAndBookInvoice({
    supabase: mockSupabase as never,
    companyId: 'company-1',
    userId: 'user-1',
    invoice: invoice as never,
    settings: theSettings,
    log,
  })
}

describe('issueAndBookInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockRenderToBuffer.mockResolvedValue(Buffer.from('fake-pdf'))
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
    mockCreateSchedules.mockResolvedValue({ created: 0, failed: 0 })
    mockRecordManualInvoiceDelivery.mockResolvedValue({ id: 'delivery-1' })
    mockEnsureInvoiceNumber.mockResolvedValue('F-2026010')
  })

  it('rejects when the payment account is missing, before number allocation', async () => {
    const bare = {
      ...settings,
      invoice_payment_accounts: {},
      clearing_number: null,
      account_number: null,
      bankgiro: null,
      plusgiro: null,
      swish: null,
      iban: null,
    } as CompanySettings

    const result = await issue(makeDraft({ invoice_number: null }), bare)

    expect(result).toEqual({
      ok: false,
      errorCode: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING',
      details: { currency: 'SEK' },
    })
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects a VAT-registered company without VAT number, before number allocation', async () => {
    const broken = { ...settings, vat_registered: true, vat_number: null } as CompanySettings

    const result = await issue(makeDraft({ invoice_number: null }), broken)

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_SEND_VAT_NUMBER_MISSING' })
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('issues for an unregistered company without VAT number', async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip
    const unregistered = {
      ...settings,
      vat_registered: false,
      vat_number: null,
      defer_invoice_booking: true,
    } as CompanySettings

    const result = await issue(makeDraft(), unregistered)

    expect(result).toEqual({ ok: true, journalEntryId: null, partialFailures: [] })
  })

  it('fails with INVOICE_CREATE_NUMBER_ASSIGN_FAILED when numbering fails', async () => {
    mockEnsureInvoiceNumber.mockRejectedValue(new Error('sequence exhausted'))

    const result = await issue()

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED' })
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('returns INVOICE_MARK_SENT_RACE when another request flipped the draft first', async () => {
    enqueue({ data: [], error: null }) // CAS update matches no row

    const result = await issue()

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_MARK_SENT_RACE' })
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it('restores the draft and fails closed when the journal entry cannot be created', async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip
    mockCreateInvoiceJournalEntry.mockRejectedValue(new Error('Period locked'))
    enqueue({ data: null, error: null }) // rollback update

    const result = await issue()

    expect(result).toEqual({ ok: false, errorCode: 'INVOICE_MARK_SENT_BOOK_FAILED' })
    // Two invoice updates: the CAS flip and the rollback to draft.
    expect(findCalls('invoices', 'update')).toEqual([
      [{ status: 'sent' }],
      [{ status: 'draft' }],
    ])
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it('books, links, archives the PDF, records delivery and emits invoice.sent', async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-7' })
    enqueue({ data: null, error: null }) // journal_entry_id link

    const emitted: string[] = []
    eventBus.on('invoice.sent', async () => {
      emitted.push('invoice.sent')
    })

    const result = await issue()

    expect(result).toEqual({ ok: true, journalEntryId: 'je-7', partialFailures: [] })
    expect(mockCreateInvoiceJournalEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      'enskild_firma',
      customer.name,
    )
    expect(mockCreateSchedules).toHaveBeenCalled()
    expect(mockUploadDocument).toHaveBeenCalledTimes(1)
    expect(mockRecordManualInvoiceDelivery).toHaveBeenCalledWith({
      supabase: mockSupabase,
      companyId: 'company-1',
      userId: 'user-1',
      invoiceId: 'inv-1',
    })
    expect(emitted).toEqual(['invoice.sent'])
  })

  it('marks sent WITHOUT booking under deferred booking (#967)', async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip

    const result = await issue(makeDraft(), {
      ...settings,
      defer_invoice_booking: true,
    } as CompanySettings)

    expect(result).toEqual({ ok: true, journalEntryId: null, partialFailures: [] })
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
    // Still a real issuance: underlag archived and delivery recorded.
    expect(mockUploadDocument).toHaveBeenCalledTimes(1)
    expect(mockRecordManualInvoiceDelivery).toHaveBeenCalledTimes(1)
  })

  it('surfaces PDF-archive failures as partial failures, not errors', async () => {
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // CAS flip
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-8' })
    enqueue({ data: null, error: null }) // journal_entry_id link
    mockUploadDocument.mockRejectedValue(new Error('Storage offline'))

    const result = await issue()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.journalEntryId).toBe('je-8')
      expect(result.partialFailures).toEqual([
        expect.objectContaining({ step: 'pdf_archive' }),
      ])
    }
  })
})
