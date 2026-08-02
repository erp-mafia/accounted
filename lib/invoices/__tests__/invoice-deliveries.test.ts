import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmailService } from '@/lib/email/service'

const mockUploadDocument = vi.fn()
const mockDeleteDocument = vi.fn()
const mockCreateServiceClient = vi.fn()
const mockGetSenderForCompany = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
  deleteDocument: (...args: unknown[]) => mockDeleteDocument(...args),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => mockCreateServiceClient(),
}))
vi.mock('@/lib/email/brand-sender', () => ({
  getSenderForCompany: (...args: unknown[]) => mockGetSenderForCompany(...args),
}))

import {
  InvoiceDeliverySnapshotError,
  recordManualInvoiceDelivery,
  reserveInvoiceDelivery,
  sendTrackedInvoiceEmail,
} from '../invoice-deliveries'

function makeSupabase(options?: {
  reserveData?: string | null
  reserveError?: { message: string } | null
  snapshotData?: string | null
  snapshotError?: { message: string } | null
  terminalData?: string | null
  terminalError?: { message: string } | null
  manualData?: Record<string, unknown> | null
  manualError?: { message: string } | null
}) {
  const rpcSpy = vi.fn((name: string) => {
    if (name === 'reserve_invoice_delivery') {
      return Promise.resolve({
        data: options?.reserveData === undefined ? 'delivery-1' : options.reserveData,
        error: options?.reserveError ?? null,
      })
    }
    if (name === 'capture_invoice_delivery_payload') {
      return Promise.resolve({
        data: options?.snapshotData === undefined ? 'delivery-1' : options.snapshotData,
        error: options?.snapshotError ?? null,
      })
    }
    if (name === 'finalize_invoice_delivery') {
      return Promise.resolve({
        data: options?.terminalData === undefined ? 'delivery-1' : options.terminalData,
        error: options?.terminalError ?? null,
      })
    }
    return Promise.resolve({
      data: options?.manualData === undefined
        ? { id: 'delivery-1', channel: 'manual', status: 'marked_sent' }
        : options.manualData,
      error: options?.manualError ?? null,
    })
  })
  mockCreateServiceClient.mockReturnValue({ rpc: rpcSpy })

  return {
    supabase: {} as SupabaseClient,
    rpcSpy,
  }
}

function makeInput(supabase: SupabaseClient, emailService: EmailService) {
  return {
    supabase,
    emailService,
    companyId: 'company-1',
    userId: 'user-1',
    invoiceId: 'invoice-1',
    deliveryId: 'delivery-1',
    to: 'customer@example.com',
    cc: ['accounting@example.com'],
    bcc: ['archive@example.com'],
    replyTo: 'sender@example.com',
    fromName: 'Example AB',
    subject: 'Faktura F-1001',
    html: '<p>Hej!</p>',
    text: 'Hej!',
    filename: 'faktura-f-1001.pdf',
    pdfBuffer: Buffer.from('exact-pdf'),
  }
}

function makeEmailService(sendEmail: EmailService['sendEmail']): EmailService {
  return { isConfigured: () => true, sendEmail }
}

describe('invoice delivery tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUploadDocument.mockResolvedValue({
      id: 'document-1',
      sha256_hash: 'sha256-exact-pdf',
    })
    mockDeleteDocument.mockResolvedValue({ ok: true })
    // Default: unbranded company (today's sender, byte for byte).
    mockGetSenderForCompany.mockResolvedValue({
      fromName: null,
      fromAddress: null,
      replyTo: null,
      brand: null,
    })
  })

  it('persists the exact payload before sending and records provider success', async () => {
    const { supabase, rpcSpy } = makeSupabase()
    const sendEmail = vi.fn().mockResolvedValue({
      success: true,
      provider: 'resend',
      messageId: 'provider-message-1',
    })

    const result = await sendTrackedInvoiceEmail(
      makeInput(supabase, makeEmailService(sendEmail)),
    )

    expect(rpcSpy).toHaveBeenNthCalledWith(
      1,
      'capture_invoice_delivery_payload',
      expect.objectContaining({
        p_to_addresses: ['customer@example.com'],
        p_cc_addresses: ['accounting@example.com'],
        p_bcc_addresses: ['archive@example.com'],
        p_subject: 'Faktura F-1001',
        p_body_text: 'Hej!',
        p_body_html: '<p>Hej!</p>',
        p_document_attachment_id: 'document-1',
        p_attachment_filename: 'faktura-f-1001.pdf',
        p_attachment_sha256: 'sha256-exact-pdf',
      }),
    )
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Faktura F-1001',
      text: 'Hej!',
      html: '<p>Hej!</p>',
      bcc: ['archive@example.com'],
      attachments: [expect.objectContaining({
        filename: 'faktura-f-1001.pdf',
        content: Buffer.from('exact-pdf'),
      })],
    }))
    expect(rpcSpy).toHaveBeenNthCalledWith(
      2,
      'finalize_invoice_delivery',
      expect.objectContaining({
        p_status: 'sent',
        p_provider: 'resend',
        p_provider_message_id: 'provider-message-1',
      }),
    )
    expect(result).toMatchObject({
      success: true,
      deliveryId: 'delivery-1',
      documentId: 'document-1',
    })
  })

  it('keeps the From header unbranded for a company without a brand', async () => {
    const { supabase } = makeSupabase()
    const sendEmail = vi.fn().mockResolvedValue({ success: true, provider: 'resend' })

    await sendTrackedInvoiceEmail(makeInput(supabase, makeEmailService(sendEmail)))

    expect(mockGetSenderForCompany).toHaveBeenCalledWith('company-1')
    const options = sendEmail.mock.calls[0][0]
    expect(options.fromName).toBe('Example AB')
    expect(options.fromAddress).toBeUndefined()
    expect(options.replyTo).toBe('sender@example.com')
  })

  it('rides the verified brand sender domain while keeping the company display name', async () => {
    mockGetSenderForCompany.mockResolvedValue({
      fromName: 'Siffra',
      fromAddress: 'noreply@post.siffra.se',
      replyTo: 'support@siffra.se',
      brand: { appName: 'Siffra' },
    })
    const { supabase } = makeSupabase()
    const sendEmail = vi.fn().mockResolvedValue({ success: true, provider: 'resend' })

    await sendTrackedInvoiceEmail(makeInput(supabase, makeEmailService(sendEmail)))

    const options = sendEmail.mock.calls[0][0]
    // The COMPANY stays the displayed sender; only the address is the brand's.
    expect(options.fromName).toBe('Example AB')
    expect(options.fromAddress).toBe('noreply@post.siffra.se')
    // Reply-to stays the company's own address, not the brand support box.
    expect(options.replyTo).toBe('sender@example.com')
  })

  it('does not attach a From address for an unverified brand sender domain', async () => {
    mockGetSenderForCompany.mockResolvedValue({
      fromName: 'Siffra',
      fromAddress: null,
      replyTo: 'support@siffra.se',
      brand: { appName: 'Siffra' },
    })
    const { supabase } = makeSupabase()
    const sendEmail = vi.fn().mockResolvedValue({ success: true, provider: 'resend' })

    await sendTrackedInvoiceEmail(makeInput(supabase, makeEmailService(sendEmail)))

    const options = sendEmail.mock.calls[0][0]
    expect(options.fromName).toBe('Example AB')
    expect(options.fromAddress).toBeUndefined()
  })

  it('does not call the provider when the immutable snapshot cannot be saved', async () => {
    const { supabase } = makeSupabase({
      snapshotData: null,
      snapshotError: { message: 'update failed' },
    })
    const sendEmail = vi.fn()

    await expect(
      sendTrackedInvoiceEmail(makeInput(supabase, makeEmailService(sendEmail))),
    ).rejects.toBeInstanceOf(InvoiceDeliverySnapshotError)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(mockDeleteDocument).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'document-1',
    )
  })

  it('records a failed provider attempt without changing the saved payload', async () => {
    const { supabase, rpcSpy } = makeSupabase()
    const sendEmail = vi.fn().mockResolvedValue({
      success: false,
      provider: 'resend',
      messageId: 'provider-returned-on-failure',
      error: 'provider rejected the request',
    })

    const result = await sendTrackedInvoiceEmail(
      makeInput(supabase, makeEmailService(sendEmail)),
    )

    expect(rpcSpy).toHaveBeenCalledWith(
      'finalize_invoice_delivery',
      expect.objectContaining({
        p_status: 'failed',
        p_provider: 'resend',
        p_provider_message_id: null,
        p_error_code: 'provider_failed',
      }),
    )
    expect(mockDeleteDocument).toHaveBeenCalledWith(supabase, 'company-1', 'document-1')
    expect(result.success).toBe(false)
  })

  it('surfaces a warning if a successful provider result cannot be finalized', async () => {
    const { supabase } = makeSupabase({ terminalError: { message: 'update failed' } })
    const sendEmail = vi.fn().mockResolvedValue({ success: true })

    const result = await sendTrackedInvoiceEmail(
      makeInput(supabase, makeEmailService(sendEmail)),
    )

    expect(result.trackingWarning).toBe('finalize_failed')
  })

  it('treats an unexpected terminal delivery id as a finalize failure', async () => {
    const { supabase } = makeSupabase({ terminalData: 'delivery-other' })
    const sendEmail = vi.fn().mockResolvedValue({ success: true })

    const result = await sendTrackedInvoiceEmail(
      makeInput(supabase, makeEmailService(sendEmail)),
    )

    expect(result.trackingWarning).toBe('finalize_failed')
  })

  it('does not delete the archived PDF when the failed terminal id is unexpected', async () => {
    const { supabase } = makeSupabase({ terminalData: 'delivery-other' })
    const sendEmail = vi.fn().mockResolvedValue({
      success: false,
      error: 'provider rejected the request',
    })

    const result = await sendTrackedInvoiceEmail(
      makeInput(supabase, makeEmailService(sendEmail)),
    )

    expect(result.trackingWarning).toBe('failure_record_failed')
    expect(mockDeleteDocument).not.toHaveBeenCalled()
  })

  it('returns the reservation selected by the privileged RPC', async () => {
    const { supabase } = makeSupabase({
      reserveData: 'delivery-existing',
    })

    await expect(reserveInvoiceDelivery({
      supabase,
      companyId: 'company-1',
      userId: 'user-1',
      invoiceId: 'invoice-1',
    })).resolves.toBe('delivery-existing')
  })

  it('records manual delivery without inventing recipient or content details', async () => {
    const manualDelivery = {
      id: 'delivery-1',
      channel: 'manual',
      status: 'marked_sent',
    }
    const { supabase, rpcSpy } = makeSupabase({ manualData: manualDelivery })

    await recordManualInvoiceDelivery({
      supabase,
      companyId: 'company-1',
      userId: 'user-1',
      invoiceId: 'invoice-1',
      sentAt: '2026-07-22T10:30:00.000Z',
    })

    expect(rpcSpy).toHaveBeenCalledWith('record_manual_invoice_delivery', {
      p_company_id: 'company-1',
      p_actor_user_id: 'user-1',
      p_invoice_id: 'invoice-1',
      p_sent_at: '2026-07-22T10:30:00.000Z',
    })
  })
})
