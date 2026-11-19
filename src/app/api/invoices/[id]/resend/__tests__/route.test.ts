import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeInvoice,
  makeCustomer,
  makeCompanySettings,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockIsConfigured = vi.fn()
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({
    sendEmail: vi.fn(),
    isConfigured: () => mockIsConfigured(),
  }),
}))

vi.mock('@/lib/email/invoice-sender', () => ({
  resolveInvoiceSender: vi.fn().mockResolvedValue(undefined),
}))

const mockGuardSandbox = vi.fn()
vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: (...args: unknown[]) => mockGuardSandbox(...args),
  isSandboxCompany: vi.fn().mockResolvedValue(false),
  sandboxBlockedResponse: vi.fn(),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/core/documents/document-service', () => ({
  downloadDocumentObject: vi.fn().mockResolvedValue({
    blob: new Blob(['the-sent-pdf']),
    error: null,
    resolvedPath: 'company-1/doc-1.pdf',
  }),
  computeSHA256: vi.fn().mockResolvedValue('sha-of-the-sent-pdf'),
}))

vi.mock('@/lib/invoices/invoice-attachments', () => ({
  loadInvoiceEmailAttachments: vi.fn().mockResolvedValue({ ok: true, value: [] }),
}))

const mockSendTrackedInvoiceEmail = vi.fn()
vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  InvoiceDeliverySnapshotError: class InvoiceDeliverySnapshotError extends Error {},
  reserveInvoiceDelivery: vi.fn().mockResolvedValue('delivery-2'),
  sendTrackedInvoiceEmail: (...args: unknown[]) => mockSendTrackedInvoiceEmail(...args),
}))

import { POST } from '../route'

interface ResendResponseBody {
  data?: { delivery_id: string; recipient_counts: { to: number; cc: number } }
  error: { code: string; message: string }
}

describe('POST /api/invoices/[id]/resend', () => {
  const mockUser = { id: 'user-1', email: 'owner@test.se' }
  const customer = makeCustomer({ id: 'cust-1', name: 'Kund AB', email: 'kund@test.se', language: 'sv' })
  const company = makeCompanySettings({ company_name: 'Acme AB', email: 'faktura@acme.se' })
  const sentInvoice = makeInvoice({ id: 'inv-1', invoice_number: '2026-0042', status: 'sent', customer })
  const archivedDelivery = {
    id: 'delivery-1',
    channel: 'email',
    status: 'sent',
    document_attachment_id: 'doc-1',
    attachment_filename: 'Faktura-2026-0042.pdf',
    sent_at: '2026-10-01T08:00:00.000Z',
  }
  const archivedDocument = {
    id: 'doc-1',
    file_name: 'Faktura-2026-0042.pdf',
    storage_path: 'company-1/doc-1.pdf',
    sha256_hash: 'sha-of-the-sent-pdf',
  }

  function post(id = 'inv-1') {
    return POST(
      createMockRequest(`/api/invoices/${id}/resend`, { method: 'POST' }),
      createMockRouteParams({ id }),
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockIsConfigured.mockReturnValue(true)
    mockGuardSandbox.mockResolvedValue(null)
    mockSendTrackedInvoiceEmail.mockResolvedValue({
      success: true,
      messageId: 'msg-2',
      deliveryId: 'delivery-2',
      documentId: 'doc-1',
    })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(401)
    expect(mockSendTrackedInvoiceEmail).not.toHaveBeenCalled()
  })

  it('returns 503 when the email service is not configured', async () => {
    mockIsConfigured.mockReturnValue(false)

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(503)
    expect(mockSendTrackedInvoiceEmail).not.toHaveBeenCalled()
  })

  it('returns the sandbox refusal before anything is read', async () => {
    const { NextResponse } = await import('next/server')
    mockGuardSandbox.mockResolvedValue(NextResponse.json({ error: { code: 'SANDBOX' } }, { status: 403 }))

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(403)
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice does not exist', async () => {
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<ResendResponseBody>(await post('missing'))

    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_NOT_FOUND')
  })

  it('returns 409 for a paid invoice', async () => {
    enqueue({ data: { ...sentInvoice, status: 'paid' } })

    const { status, body } = await parseJsonResponse<ResendResponseBody>(await post())

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_RESEND_NOT_ELIGIBLE')
    expect(mockSendTrackedInvoiceEmail).not.toHaveBeenCalled()
  })

  it('returns 400 when the customer has no email address', async () => {
    enqueue({ data: { ...sentInvoice, customer: { ...customer, email: null } } })

    const { status, body } = await parseJsonResponse<ResendResponseBody>(await post())

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_SEND_NO_CUSTOMER_EMAIL')
  })

  it('returns 409 when nothing was emailed from here', async () => {
    enqueue({ data: sentInvoice })
    enqueue({ data: [] })

    const { status, body } = await parseJsonResponse<ResendResponseBody>(await post())

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_RESEND_NO_ARCHIVED_COPY')
    expect(body.error.message).toContain('Ladda ner PDF:en')
  })

  it('emails the copy and returns the new delivery', async () => {
    enqueue({ data: sentInvoice })
    enqueue({ data: [archivedDelivery] })
    enqueue({ data: archivedDocument })
    enqueue({ data: company })

    const { status, body } = await parseJsonResponse<ResendResponseBody>(await post())

    expect(status).toBe(200)
    expect(body).toEqual({
      data: { delivery_id: 'delivery-2', recipient_counts: { to: 1, cc: 0 } },
    })
    expect(mockSendTrackedInvoiceEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Kopia: Faktura 2026-0042 från Acme AB',
      archivedDocument: { id: 'doc-1', sha256Hash: 'sha-of-the-sent-pdf' },
    }))
  })

  it('returns 502 when the provider refuses the email', async () => {
    mockSendTrackedInvoiceEmail.mockResolvedValue({
      success: false,
      error: 'rejected',
      deliveryId: 'delivery-2',
      documentId: 'doc-1',
    })
    enqueue({ data: sentInvoice })
    enqueue({ data: [archivedDelivery] })
    enqueue({ data: archivedDocument })
    enqueue({ data: company })

    const { status, body } = await parseJsonResponse<ResendResponseBody>(await post())

    expect(status).toBe(502)
    expect(body.error.code).toBe('INVOICE_SEND_PROVIDER_FAILED')
  })
})
