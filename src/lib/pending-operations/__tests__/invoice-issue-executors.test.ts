/**
 * send_invoice and mark_invoice_sent issue the invoice (status sent + its
 * verifikat, fail closed) BEFORE anything reaches the customer, through the
 * same markInvoiceSentAndBook the dashboard send, mark-sent and the recurring
 * auto-send use. A verifikat the engine refuses leaves the invoice in draft
 * and delivers nothing; the happy path is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeInvoice, makeCustomer } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { MandatoryDimensionMissingError } from '@/lib/bookkeeping/dimension-errors'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))

vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('pdf')),
}))

vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: vi.fn().mockReturnValue({}),
  brandingFromCompanySettings: vi.fn().mockReturnValue({}),
}))

vi.mock('@/lib/invoices/pdf-render-helpers', () => ({
  prepareInvoicePdfRender: vi.fn().mockResolvedValue({ branding: {}, company: {} }),
}))

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: () => true, sendEmail: vi.fn() }),
}))

vi.mock('@/lib/email/invoice-sender', () => ({
  resolveInvoiceSender: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/email/invoice-templates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/invoice-templates')>()),
  generateInvoiceEmailHtml: vi.fn().mockReturnValue('<html />'),
  generateInvoiceEmailText: vi.fn().mockReturnValue('text'),
  generateInvoiceEmailSubject: vi.fn().mockReturnValue('Faktura'),
}))

const mocks = vi.hoisted(() => ({
  sendTrackedInvoiceEmail: vi.fn(),
  recordManualInvoiceDelivery: vi.fn(),
  createInvoiceJournalEntry: vi.fn(),
  uploadDocument: vi.fn(),
  linkToJournalEntry: vi.fn(),
}))

vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  reserveInvoiceDelivery: vi.fn().mockResolvedValue('delivery-1'),
  sendTrackedInvoiceEmail: mocks.sendTrackedInvoiceEmail,
  recordManualInvoiceDelivery: mocks.recordManualInvoiceDelivery,
}))

vi.mock('@/lib/invoices/ensure-invoice-number', () => ({
  ensureInvoiceNumber: vi.fn().mockResolvedValue('F-2026001'),
}))

vi.mock('@/lib/bookkeeping/invoice-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/invoice-entries')>()),
  createInvoiceJournalEntry: mocks.createInvoiceJournalEntry,
}))

vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  uploadDocument: mocks.uploadDocument,
  linkToJournalEntry: mocks.linkToJournalEntry,
}))

import { commitPendingOperation } from '../commit'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'

const customer = makeCustomer({ id: 'cust-1', name: 'Kund AB', email: 'kund@example.se' })

function draftInvoice() {
  return makeInvoice({
    id: 'invoice-1',
    status: 'draft',
    invoice_number: 'F-2026001',
    credited_invoice_id: null,
    document_type: 'invoice',
    customer,
    items: [],
  })
}

const SETTINGS = {
  company_name: 'Test AB',
  accounting_method: 'accrual',
  entity_type: 'enskild_firma',
  bankgiro: '123-4567',
  invoice_email_cc_addresses: [],
  invoice_email_bcc_addresses: [],
}

function op(operation_type: PendingOperation['operation_type']): PendingOperation {
  const overrides: Partial<PendingOperation> = { operation_type, params: { invoice_id: 'invoice-1' } }
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    status: 'pending',
    title: 'test',
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-06-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

const refusal = () =>
  new MandatoryDimensionMissingError([
    { account_number: '3001', sie_dim_no: '6', dimension_name: 'Projekt' },
  ])

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mocks.sendTrackedInvoiceEmail.mockResolvedValue({
    success: true,
    messageId: 'msg-1',
    deliveryId: 'delivery-1',
    documentId: 'document-1',
  })
  mocks.recordManualInvoiceDelivery.mockResolvedValue({ id: 'delivery-1' })
  mocks.createInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })
  mocks.uploadDocument.mockResolvedValue({ id: 'underlag-1' })
  mocks.linkToJournalEntry.mockResolvedValue(undefined)
})

describe('commitPendingOperation: send_invoice issues before it emails', () => {
  it('books, then emails, and answers as before', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: draftInvoice(), error: null })
    enqueue({ data: SETTINGS, error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent
    enqueue({ data: null, error: null }) // journal_entry_id link
    enqueue({ data: null, error: null }) // dispatcher finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op('send_invoice'))

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ message: 'Invoice F-2026001 sent to kund@example.se' })
    expect(mocks.createInvoiceJournalEntry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendTrackedInvoiceEmail.mock.invocationCallOrder[0],
    )
    expect(findCalls('invoices', 'update')).toEqual([[{ status: 'sent' }], [{ journal_entry_id: 'je-1' }]])
    expect(mocks.linkToJournalEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'document-1', 'je-1')
  })

  it('a refused verifikat emails nothing: the invoice is back in draft and the engine reason returned', async () => {
    mocks.createInvoiceJournalEntry.mockRejectedValue(refusal())
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: draftInvoice(), error: null })
    enqueue({ data: SETTINGS, error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // rollback to draft
    enqueue({ data: null, error: null }) // dispatcher reject

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op('send_invoice'))

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toContain('Konto 3001 kräver Projekt')
    expect(mocks.sendTrackedInvoiceEmail).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toEqual([[{ status: 'sent' }], [{ status: 'draft' }]])
  })

  it('an email that fails after the verifikat posted lands in failed_partial with the verifikat id', async () => {
    mocks.sendTrackedInvoiceEmail.mockResolvedValue({
      success: false,
      error: 'provider down',
      deliveryId: 'delivery-1',
      documentId: 'document-1',
    })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: draftInvoice(), error: null })
    enqueue({ data: SETTINGS, error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent
    enqueue({ data: null, error: null }) // journal_entry_id link
    enqueue({ data: null, error: null }) // dispatcher failed_partial

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op('send_invoice'))

    expect(result.status).toBe('failed')
    expect(result.operation_status).toBe('failed_partial')
    expect(result.data).toEqual({ posted_ids: { journal_entry_id: 'je-1' } })
    // Issued stays issued (a posted verifikat is never undone), underlag archived.
    expect(findCalls('invoices', 'update')).not.toContainEqual([{ status: 'draft' }])
    expect(mocks.uploadDocument).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'company-1',
      expect.objectContaining({ type: 'application/pdf' }),
      expect.objectContaining({ journal_entry_id: 'je-1' }),
    )
  })
})

describe('commitPendingOperation: mark_invoice_sent issues fail closed', () => {
  it('books and marks sent, recording the manual delivery, as before', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: draftInvoice(), error: null })
    enqueue({ data: SETTINGS, error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent
    enqueue({ data: null, error: null }) // journal_entry_id link
    enqueue({ data: null, error: null }) // dispatcher finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op('mark_invoice_sent'))

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ status: 'sent', journal_entry_id: 'je-1' })
    expect(mocks.recordManualInvoiceDelivery).toHaveBeenCalledTimes(1)
  })

  it('a refused verifikat never marks the invoice sent: draft restored, no delivery recorded', async () => {
    mocks.createInvoiceJournalEntry.mockRejectedValue(refusal())
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: draftInvoice(), error: null })
    enqueue({ data: SETTINGS, error: null })
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // status flip draft -> sent
    enqueue({ data: [{ id: 'invoice-1' }], error: null }) // rollback to draft
    enqueue({ data: null, error: null }) // dispatcher reject

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op('mark_invoice_sent'))

    expect(result.status).toBe('failed')
    expect(result.error).toContain('Konto 3001 kräver Projekt')
    expect(findCalls('invoices', 'update')).toEqual([[{ status: 'sent' }], [{ status: 'draft' }]])
    expect(mocks.recordManualInvoiceDelivery).not.toHaveBeenCalled()
  })
})

// invoices.customer_id is ON DELETE SET NULL: a draft whose customer was
// deleted comes back with customer_id and the join null (crm#263). Neither
// executor may number, issue or email it, and neither may crash on it.
describe('commitPendingOperation: an invoice without a customer is refused before anything changes', () => {
  const orphanDraft = () => ({ ...draftInvoice(), invoice_number: null, customer_id: null, customer: null })

  it.each(['send_invoice', 'mark_invoice_sent'] as const)('%s answers INVOICE_CUSTOMER_MISSING', async (type) => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: orphanDraft(), error: null })
    enqueue({ data: null, error: null }) // dispatcher reject

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op(type))

    // A 409 is the dispatcher's auto-reject: the staged op no longer fits.
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('INVOICE_CUSTOMER_MISSING')
    expect(result.error).toContain('Fakturan saknar kund')
    expect(vi.mocked(ensureInvoiceNumber)).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'update')).toEqual([])
    expect(mocks.sendTrackedInvoiceEmail).not.toHaveBeenCalled()
  })
})
