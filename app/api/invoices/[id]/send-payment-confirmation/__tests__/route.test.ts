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
import { InvoicePDF } from '@/lib/invoices/pdf-template'

const mockSendEmail = vi.fn()
const mockIsConfigured = vi.fn()
vi.mock('@/lib/email/invoice-sender', () => ({
  resolveInvoiceSender: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    isConfigured: () => mockIsConfigured(),
  }),
}))

vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: vi.fn().mockResolvedValue(null),
  isSandboxCompany: vi.fn().mockResolvedValue(false),
  sandboxBlockedResponse: vi.fn(),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))

import { POST } from '../route'

describe('POST /api/invoices/[id]/send-payment-confirmation', () => {
  const mockUser = { id: 'user-1', email: 'owner@test.se' }
  const customer = makeCustomer({ id: 'cust-1', name: 'Kund AB', email: 'kund@test.se', language: 'sv' })
  const company = makeCompanySettings({
    company_name: 'Acme AB',
    email: 'faktura@acme.se',
    bankgiro: '123-4567',
  })
  const paidInvoice = makeInvoice({
    id: 'inv-1',
    invoice_number: '2026-0042',
    status: 'paid',
    paid_amount: 12500,
    remaining_amount: 0,
    paid_at: '2026-08-17T12:00:00+00:00',
    customer,
    items: [
      {
        id: 'item-1',
        invoice_id: 'inv-1',
        sort_order: 0,
        description: 'Consulting',
        quantity: 10,
        unit: 'tim',
        unit_price: 1000,
        line_total: 10000,
        vat_rate: 25,
        vat_amount: 2500,
        created_at: '2026-06-15T14:30:00Z',
      },
    ],
  })

  function post(id = 'inv-1') {
    return POST(
      createMockRequest(`/api/invoices/${id}/send-payment-confirmation`, { method: 'POST' }),
      createMockRouteParams({ id }),
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockIsConfigured.mockReturnValue(true)
    mockRenderToBuffer.mockResolvedValue(Buffer.from('fake-paid-pdf'))
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-1', provider: 'resend' })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(401)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('returns 503 when the email service is not configured', async () => {
    mockIsConfigured.mockReturnValue(false)

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(503)
  })

  it('returns 404 when the invoice does not exist', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const { status, body } = await parseJsonResponse(await post('missing'))

    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_PAID_NOT_FOUND')
  })

  it.each(['sent', 'partially_paid', 'overdue', 'draft'])(
    'returns 409 without rendering or mailing when the invoice is %s',
    async (status) => {
      enqueue({ data: { ...paidInvoice, status }, error: null })

      const response = await parseJsonResponse(await post())

      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('INVOICE_PAYMENT_CONFIRMATION_NOT_PAID')
      expect(mockRenderToBuffer).not.toHaveBeenCalled()
      expect(mockSendEmail).not.toHaveBeenCalled()
    },
  )

  it('returns 400 when the customer has no email', async () => {
    enqueue({ data: { ...paidInvoice, customer: { ...customer, email: null } }, error: null })

    const { status, body } = await parseJsonResponse(await post())

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_SEND_NO_CUSTOMER_EMAIL')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('returns 404 when company settings are missing', async () => {
    enqueue({ data: paidInvoice, error: null })
    enqueue({ data: null, error: { message: 'missing' } })

    const { status, body } = await parseJsonResponse(await post())

    expect(status).toBe(404)
    expect(body.error.code).toBe('INVOICE_SEND_COMPANY_SETTINGS_MISSING')
  })

  it('emails the paid re-render as a betalningsbekräftelse without touching the invoice', async () => {
    enqueue({ data: paidInvoice, error: null })
    enqueue({ data: company, error: null })

    const { status, body } = await parseJsonResponse(await post())

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.message).toContain('kund@test.se')

    // The row is rendered as stored (status paid): the template stamps BETALD.
    expect(InvoicePDF).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: expect.objectContaining({ status: 'paid' }) }),
    )

    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    const sent = mockSendEmail.mock.calls[0][0] as {
      to: string[]
      subject: string
      html: string
      text: string
      replyTo?: string
      fromName?: string
      attachments: Array<{ filename: string; content: Buffer; contentType?: string }>
    }
    expect(sent.to).toEqual(['kund@test.se'])
    expect(sent.subject).toBe('Betalningsbekräftelse för faktura 2026-0042 från Acme AB')
    expect(sent.html).toContain('betald i sin helhet')
    expect(sent.text).toContain('Betalt belopp:')
    expect(sent.replyTo).toBe('faktura@acme.se')
    expect(sent.fromName).toBe('Acme AB')
    expect(sent.attachments).toEqual([
      {
        filename: 'Betalningsbekraftelse-2026-0042.pdf',
        content: Buffer.from('fake-paid-pdf'),
        contentType: 'application/pdf',
      },
    ])

    // No status flip, no delivery-history row, no journal write: the
    // confirmation is a resend of a document, not an issuance.
    expect(mockSupabase.from).not.toHaveBeenCalledWith('invoice_deliveries')
    expect(mockSupabase.from).not.toHaveBeenCalledWith('journal_entries')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 502 when the provider refuses the email', async () => {
    enqueue({ data: paidInvoice, error: null })
    enqueue({ data: company, error: null })
    mockSendEmail.mockResolvedValue({ success: false, error: 'provider down' })

    const { status, body } = await parseJsonResponse(await post())

    expect(status).toBe(502)
    expect(body.error.code).toBe('INVOICE_SEND_PROVIDER_FAILED')
  })

  it('returns 500 when the PDF cannot be rendered and sends nothing', async () => {
    enqueue({ data: paidInvoice, error: null })
    enqueue({ data: company, error: null })
    mockRenderToBuffer.mockRejectedValueOnce(new Error('render failed'))

    const { status, body } = await parseJsonResponse(await post())

    expect(status).toBe(500)
    expect(body.error.code).toBe('INVOICE_PDF_RENDER_FAILED')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })
})
