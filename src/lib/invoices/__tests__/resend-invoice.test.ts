import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmailService } from '@/lib/email/service'
import {
  createQueuedMockSupabase,
  makeCompanySettings,
  makeCustomer,
  makeInvoice,
} from '@/tests/helpers'
import { createLogger } from '@/lib/logger'

const mockDownloadDocumentObject = vi.fn()
const mockComputeSHA256 = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  downloadDocumentObject: (...args: unknown[]) => mockDownloadDocumentObject(...args),
  computeSHA256: (...args: unknown[]) => mockComputeSHA256(...args),
}))

const mockReserveInvoiceDelivery = vi.fn()
const mockSendTrackedInvoiceEmail = vi.fn()
vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  InvoiceDeliverySnapshotError: class InvoiceDeliverySnapshotError extends Error {},
  reserveInvoiceDelivery: (...args: unknown[]) => mockReserveInvoiceDelivery(...args),
  sendTrackedInvoiceEmail: (...args: unknown[]) => mockSendTrackedInvoiceEmail(...args),
}))

const mockLoadInvoiceEmailAttachments = vi.fn()
vi.mock('@/lib/invoices/invoice-attachments', () => ({
  loadInvoiceEmailAttachments: (...args: unknown[]) => mockLoadInvoiceEmailAttachments(...args),
}))

vi.mock('@/lib/email/invoice-sender', () => ({
  resolveInvoiceSender: vi.fn().mockResolvedValue(undefined),
}))

import { resendInvoiceEmail } from '../resend-invoice'

const { supabase, enqueue, reset, calls } = createQueuedMockSupabase()

const customer = makeCustomer({ id: 'cust-1', name: 'Kund AB', email: 'kund@test.se', language: 'sv' })
const company = makeCompanySettings({ company_name: 'Acme AB', email: 'faktura@acme.se' })
const sentInvoice = makeInvoice({
  id: 'inv-1',
  invoice_number: '2026-0042',
  status: 'sent',
  customer,
})
const archivedDelivery = {
  id: 'delivery-1',
  channel: 'email',
  status: 'sent',
  document_attachment_id: 'doc-1',
  attachment_filename: 'Faktura-2026-0042.pdf',
  sent_at: '2026-10-01T08:00:00.000Z',
  created_at: '2026-10-01T07:59:58.000Z',
}
const archivedDocument = {
  id: 'doc-1',
  file_name: 'stored-name.pdf',
  storage_path: 'company-1/doc-1.pdf',
  sha256_hash: 'sha-of-the-sent-pdf',
}

function run() {
  return resendInvoiceEmail({
    supabase: supabase as unknown as SupabaseClient,
    emailService: { isConfigured: () => true, sendEmail: vi.fn() } as EmailService,
    companyId: 'company-1',
    userId: 'user-1',
    userEmail: 'owner@test.se',
    invoiceId: 'inv-1',
    log: createLogger('test'),
  })
}

/** Queue the reads of a resend in order: invoice, history, document, settings. */
function enqueueReads(overrides: {
  invoice?: unknown
  deliveries?: unknown
  deliveriesError?: unknown
  document?: unknown
} = {}) {
  enqueue({ data: 'invoice' in overrides ? overrides.invoice : sentInvoice })
  enqueue({
    data: 'deliveries' in overrides ? overrides.deliveries : [archivedDelivery],
    error: overrides.deliveriesError ?? null,
  })
  enqueue({ data: 'document' in overrides ? overrides.document : archivedDocument })
  enqueue({ data: company })
}

describe('resendInvoiceEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockDownloadDocumentObject.mockResolvedValue({
      blob: new Blob(['the-sent-pdf']),
      error: null,
      resolvedPath: archivedDocument.storage_path,
    })
    mockComputeSHA256.mockResolvedValue('sha-of-the-sent-pdf')
    mockLoadInvoiceEmailAttachments.mockResolvedValue({ ok: true, value: [] })
    mockReserveInvoiceDelivery.mockResolvedValue('delivery-2')
    mockSendTrackedInvoiceEmail.mockResolvedValue({
      success: true,
      messageId: 'msg-2',
      deliveryId: 'delivery-2',
      documentId: 'doc-1',
    })
  })

  it('emails the archived file as a copy and records it against the same document', async () => {
    enqueueReads()

    const result = await run()

    expect(result).toEqual({
      ok: true,
      deliveryId: 'delivery-2',
      messageId: 'msg-2',
      recipientCounts: { to: 1, cc: 0 },
    })
    expect(mockDownloadDocumentObject).toHaveBeenCalledWith(supabase, 'company-1/doc-1.pdf', 'company-1')
    const sent = mockSendTrackedInvoiceEmail.mock.calls[0][0]
    expect(sent).toMatchObject({
      deliveryId: 'delivery-2',
      to: ['kund@test.se'],
      subject: 'Kopia: Faktura 2026-0042 från Acme AB',
      filename: 'Faktura-2026-0042.pdf',
      archivedDocument: { id: 'doc-1', sha256Hash: 'sha-of-the-sent-pdf' },
    })
    expect(sent.pdfBuffer.toString()).toBe('the-sent-pdf')
    expect(sent.text).toContain('Det här är en kopia av faktura 2026-0042 som skickades 2026-10-01.')
  })

  it('changes nothing on the invoice itself', async () => {
    enqueueReads()

    await run()

    expect(calls.filter((c) => ['update', 'insert', 'upsert', 'delete'].includes(c.method))).toEqual([])
  })

  it('carries the files the invoice was emailed with', async () => {
    const timeReport = { filename: 'tidrapport.pdf', content: Buffer.from('report'), contentType: 'application/pdf' }
    mockLoadInvoiceEmailAttachments.mockResolvedValue({ ok: true, value: [timeReport] })
    enqueueReads()

    await run()

    expect(mockSendTrackedInvoiceEmail.mock.calls[0][0].extraAttachments).toEqual([timeReport])
  })

  it('refuses an invoice that does not exist in the company', async () => {
    enqueue({ data: null })

    expect(await run()).toEqual({ ok: false, code: 'INVOICE_NOT_FOUND' })
    expect(mockSendTrackedInvoiceEmail).not.toHaveBeenCalled()
  })

  it.each(['paid', 'partially_paid', 'credited', 'draft'] as const)('refuses a %s invoice', async (status) => {
    enqueueReads({ invoice: { ...sentInvoice, status } })

    expect(await run()).toEqual({
      ok: false,
      code: 'INVOICE_RESEND_NOT_ELIGIBLE',
      details: { currentStatus: status },
    })
    expect(mockReserveInvoiceDelivery).not.toHaveBeenCalled()
  })

  it('refuses when the customer has no email address', async () => {
    enqueueReads({ invoice: { ...sentInvoice, customer: { ...customer, email: null } } })

    expect(await run()).toMatchObject({ ok: false, code: 'INVOICE_SEND_NO_CUSTOMER_EMAIL' })
  })

  it('refuses an invoice that was marked sent by hand, never emailed from here', async () => {
    enqueueReads({
      deliveries: [
        { id: 'manual', channel: 'manual', status: 'marked_sent', document_attachment_id: null, sent_at: '2026-10-01T08:00:00Z' },
      ],
    })

    expect(await run()).toEqual({ ok: false, code: 'INVOICE_RESEND_NO_ARCHIVED_COPY' })
    expect(mockDownloadDocumentObject).not.toHaveBeenCalled()
  })

  it('refuses when the delivery history cannot be read', async () => {
    enqueueReads({ deliveries: null, deliveriesError: { message: 'rpc failed' } })

    expect(await run()).toEqual({ ok: false, code: 'INVOICE_RESEND_ARCHIVE_UNAVAILABLE' })
  })

  it('never sends a file that does not match the archived checksum', async () => {
    mockComputeSHA256.mockResolvedValue('some-other-hash')
    enqueueReads()

    expect(await run()).toEqual({ ok: false, code: 'INVOICE_RESEND_ARCHIVE_UNAVAILABLE' })
    expect(mockReserveInvoiceDelivery).not.toHaveBeenCalled()
    expect(mockSendTrackedInvoiceEmail).not.toHaveBeenCalled()
  })

  it('refuses when the archived file cannot be downloaded', async () => {
    mockDownloadDocumentObject.mockResolvedValue({ blob: null, error: { message: 'gone' }, resolvedPath: null })
    enqueueReads()

    expect(await run()).toEqual({ ok: false, code: 'INVOICE_RESEND_ARCHIVE_UNAVAILABLE' })
    expect(mockSendTrackedInvoiceEmail).not.toHaveBeenCalled()
  })

  it('reports a provider failure as retryable', async () => {
    mockSendTrackedInvoiceEmail.mockResolvedValue({
      success: false,
      error: 'rejected',
      deliveryId: 'delivery-2',
      documentId: 'doc-1',
    })
    enqueueReads()

    expect(await run()).toEqual({
      ok: false,
      code: 'INVOICE_SEND_PROVIDER_FAILED',
      details: { retryable: true },
    })
  })
})
