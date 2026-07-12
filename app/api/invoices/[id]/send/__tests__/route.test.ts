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
import { eventBus } from '@/lib/events'

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
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    isConfigured: () => mockIsConfigured(),
  }),
}))

vi.mock('@/lib/email/invoice-templates', () => ({
  generateInvoiceEmailHtml: vi.fn().mockReturnValue('<html>Invoice</html>'),
  generateInvoiceEmailText: vi.fn().mockReturnValue('Invoice text'),
  generateInvoiceEmailSubject: vi.fn().mockReturnValue('Faktura F-2024001'),
}))

const mockCreateInvoiceJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: (...args: unknown[]) =>
    mockCreateInvoiceJournalEntry(...args),
}))

// The sandbox guard issues a company_settings query at the top of the route;
// short-circuit it in tests since the queued mock-supabase is shaped for the
// route's existing fetch chain, not an extra pre-flight read.
vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: vi.fn().mockResolvedValue(null),
  isSandboxCompany: vi.fn().mockResolvedValue(false),
  sandboxBlockedResponse: vi.fn(),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))

import { POST } from '../route'

describe('POST /api/invoices/[id]/send', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const customer = makeCustomer({ id: 'cust-1', email: 'kund@test.se' })
  const company = makeCompanySettings({ accounting_method: 'accrual' })
  const invoice = makeInvoice({
    id: 'inv-1',
    status: 'draft',
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
        created_at: '2024-06-15T14:30:00Z',
      },
    ],
  })

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockIsConfigured.mockReturnValue(true)
    mockRenderToBuffer.mockResolvedValue(Buffer.from('fake-pdf'))
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 503 when email service is not configured', async () => {
    mockIsConfigured.mockReturnValue(false)

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(503)
  })

  it('returns 404 when invoice not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_PAID_NOT_FOUND')
  })

  it('returns 400 when invoice is cancelled (makulerad)', async () => {
    const cancelledInvoice = makeInvoice({
      id: 'inv-1',
      status: 'cancelled',
      invoice_number: 'F-2026001',
      items: [],
    })
    enqueue({ data: cancelledInvoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_SEND_CANCELLED')
  })

  it('returns 400 when customer has no email', async () => {
    const noEmailInvoice = makeInvoice({
      id: 'inv-1',
      customer: makeCustomer({ email: null }),
      items: [],
    })
    enqueue({ data: noEmailInvoice, error: null })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_SEND_NO_CUSTOMER_EMAIL')
  })

  it('returns 404 when company settings not found', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_SEND_COMPANY_SETTINGS_MISSING')
  })

  it('sends invoice email, updates status, creates journal entry for accrual', async () => {
    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Fetch company settings
    enqueue({ data: company, error: null })

    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Update invoice status to 'sent'
    enqueue({ data: null, error: null })
    // Update invoice with journal_entry_id
    enqueue({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      messageId: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.messageId).toBe('msg-1')
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'kund@test.se',
        subject: 'Faktura F-2024001',
      })
    )
    expect(mockCreateInvoiceJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      'enskild_firma'
    )
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invoice.sent' })
    )
  })

  it('skips journal entry for cash method', async () => {
    const cashCompany = makeCompanySettings({ accounting_method: 'cash' })
    enqueue({ data: invoice, error: null })
    enqueue({ data: cashCompany, error: null })

    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-2' })

    // Update invoice status
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
  })

  it('does not fail when journal entry creation fails (non-blocking)', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-3' })
    mockCreateInvoiceJournalEntry.mockRejectedValue(new Error('Period locked'))

    // Update invoice status
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('assigns an invoice number when sending a draft with no number', async () => {
    const draftWithoutNumber = makeInvoice({
      id: 'inv-1',
      status: 'draft',
      invoice_number: null,
      customer,
      items: invoice.items,
    })

    // Fetch invoice (no number)
    enqueue({ data: draftWithoutNumber, error: null })
    // Fetch company settings
    enqueue({ data: company, error: null })
    // ensureInvoiceNumber: rpc generate_invoice_number (RPC now persists internally)
    enqueue({ data: 'F-2026010', error: null })

    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-99' })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Update status to 'sent'
    enqueue({ data: null, error: null })
    // Update with journal_entry_id
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('generate_invoice_number', {
      p_company_id: 'company-1',
      p_invoice_id: 'inv-1',
      p_document_type: 'invoice',
    })
    // The journal entry should see the freshly-assigned number
    expect(mockCreateInvoiceJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ invoice_number: 'F-2026010' }),
      'enskild_firma'
    )
  })

  it('does not re-assign number when draft already has one (idempotency)', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-100' })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-2' })

    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('generate_invoice_number', expect.anything())
  })

  it('does NOT consume an invoice number when PDF render fails (preflight)', async () => {
    const draftWithoutNumber = makeInvoice({
      id: 'inv-1',
      status: 'draft',
      invoice_number: null,
      customer,
      items: invoice.items,
    })

    enqueue({ data: draftWithoutNumber, error: null })
    enqueue({ data: company, error: null })

    // First render call (the preflight) throws.
    mockRenderToBuffer.mockRejectedValueOnce(new Error('PDF render exploded'))

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_SEND_PDF_RENDER_FAILED')
    // Critical: counter must not have advanced.
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('generate_invoice_number', expect.anything())
    // Email must not have been attempted.
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('returns 500 when email sending fails', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    mockSendEmail.mockResolvedValue({ success: false, error: 'SMTP error' })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    // Provider errors map to 502 PROVIDER_FAILED with the provider message in details.
    expect(status).toBe(502)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_SEND_PROVIDER_FAILED')
    expect(
      (body.error as unknown as { details?: { providerError?: string } }).details?.providerError,
    ).toContain('SMTP error')
  })

  it('renders the final PDF as if already sent (no UTKAST banner)', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-banner' })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })

    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // Final render: invoice already has an invoice_number on the fixture, so
    // preflight is skipped and InvoicePDF is called exactly once. The status
    // passed in must be 'sent': otherwise pdf-template.tsx renders the
    // "UTKAST: inte en giltig faktura" banner on the customer's PDF.
    expect(vi.mocked(InvoicePDF)).toHaveBeenCalledTimes(1)
    const renderArgs = vi.mocked(InvoicePDF).mock.calls[0][0]
    expect(renderArgs.invoice.status).toBe('sent')
    expect(renderArgs.invoice.invoice_number).toBe('F-2024001')
  })
})
