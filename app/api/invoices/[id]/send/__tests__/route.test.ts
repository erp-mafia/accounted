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

const mockIssueCreditNote = vi.fn()
vi.mock('@/lib/invoices/issue-credit-note', () => ({
  issueCreditNote: (...args: unknown[]) => mockIssueCreditNote(...args),
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
    mockIssueCreditNote.mockResolvedValue({
      complete: true,
      journalEntryId: 'credit-je-1',
      journalEntryRequired: true,
      failures: [],
    })
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

  it.each(['sent', 'paid', 'overdue', 'partially_paid', 'credited'] as const)(
    'returns 409 and posts no journal entry when invoice status is %s',
    async (issuedStatus) => {
      const issuedInvoice = makeInvoice({
        id: 'inv-1',
        status: issuedStatus,
        customer,
        items: [],
      })
      enqueue({ data: issuedInvoice, error: null })

      const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
      const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
      const { status, body } = await parseJsonResponse<{ error: string }>(response)

      expect(status).toBe(409)
      expect((body.error as unknown as { code: string }).code).toBe('INVOICE_ALREADY_SENT')
      expect(mockSendEmail).not.toHaveBeenCalled()
      expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
    },
  )

  it('skips journal entry, archive and event when a concurrent request won the status flip', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-race' })

    // Optimistic-locked flip matches 0 rows: another request already sent it.
    enqueue({ data: [], error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      partial?: boolean
      partial_failures?: Array<{ step: string }>
    }>(response)

    // The email did go out, so the response is still a (partial) success.
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.partial).toBe(true)
    expect(body.partial_failures?.some((f) => f.step === 'status_update')).toBe(true)
    // The winning request owns the bookkeeping: no second verifikat here.
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
    expect(emitSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invoice.sent' })
    )
  })

  it('defers the journal entry when the status flip errors (row stays draft, retry re-books once)', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-fliperr' })

    // Status flip hits a DB error: the invoice remains 'draft'.
    enqueue({ data: null, error: { message: 'connection reset' } })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      partial?: boolean
      partial_failures?: Array<{ step: string; reason: string }>
    }>(response)

    expect(status).toBe(200)
    expect(body.partial).toBe(true)
    expect(body.partial_failures?.some((f) => f.step === 'status_update')).toBe(true)
    // No entry now: the retry (invoice still draft) runs the full pipeline
    // and posts exactly one, instead of this request + the retry posting two.
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
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

    // Update invoice status to 'sent' (optimistic lock: returns the matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })
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

  it('issues and books a credit-note draft through the email send flow', async () => {
    const creditNote = makeInvoice({
      id: 'credit-1',
      invoice_number: 'KR-F-2024001',
      status: 'draft',
      credited_invoice_id: 'inv-1',
      customer,
      items: (invoice.items ?? []).map((item) => ({
        ...item,
        invoice_id: 'credit-1',
        quantity: -Math.abs(item.quantity),
        line_total: -Math.abs(item.line_total),
        vat_amount: -Math.abs(item.vat_amount ?? 0),
      })),
      subtotal: -10000,
      vat_amount: -2500,
      total: -12500,
    })
    const original = {
      id: 'inv-1',
      invoice_number: 'F-2024001',
      status: 'sent',
      journal_entry_id: 'original-je-1',
      paid_at: null,
      paid_amount: null,
      total: 12500,
    }

    enqueue({ data: creditNote, error: null })
    enqueue({ data: company, error: null })
    enqueue({ data: original, error: null })
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'credit-message-1' })
    enqueue({ data: [{ id: 'credit-1' }], error: null })
    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/invoices/credit-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'credit-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; message: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.message).toContain('Kreditfakturan har skickats')
    expect(mockIssueCreditNote).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        creditNote: expect.objectContaining({ id: 'credit-1' }),
        originalInvoice: original,
        accountingMethod: 'accrual',
      }),
    )
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({ filename: 'kreditfaktura-KR-F-2024001.pdf' }),
        ],
      }),
    )
    expect(emitSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invoice.sent' }),
    )
  })

  it('does not email a credit note when its bookkeeping cannot be completed', async () => {
    const creditNote = makeInvoice({
      id: 'credit-1',
      invoice_number: 'KR-F-2024001',
      status: 'draft',
      credited_invoice_id: 'inv-1',
      customer,
      items: invoice.items,
    })
    enqueue({ data: creditNote, error: null })
    enqueue({ data: company, error: null })
    enqueue({
      data: {
        id: 'inv-1',
        invoice_number: 'F-2024001',
        status: 'sent',
        journal_entry_id: 'original-je-1',
        paid_at: null,
        paid_amount: null,
        total: 12500,
      },
      error: null,
    })
    enqueue({ data: [{ id: 'credit-1' }], error: null })
    mockIssueCreditNote.mockResolvedValue({
      complete: false,
      journalEntryId: null,
      journalEntryRequired: true,
      failures: [{ step: 'journal_entry', reason: 'Perioden är låst' }],
    })
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/invoices/credit-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'credit-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('retries delivery for an already-issued credit note after provider failure', async () => {
    const creditNote = makeInvoice({
      id: 'credit-1',
      invoice_number: 'KR-F-2024001',
      status: 'sent',
      credited_invoice_id: 'inv-1',
      customer,
      items: invoice.items,
    })
    enqueue({ data: creditNote, error: null })
    enqueue({ data: company, error: null })
    enqueue({
      data: {
        id: 'inv-1',
        invoice_number: 'F-2024001',
        status: 'credited',
        journal_entry_id: 'original-je-1',
        paid_at: null,
        paid_amount: null,
        total: 12500,
      },
      error: null,
    })
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'retry-message-1' })

    const response = await POST(
      createMockRequest('/api/invoices/credit-1/send', { method: 'POST' }),
      createMockRouteParams({ id: 'credit-1' }),
    )

    expect(response.status).toBe(200)
    expect(mockIssueCreditNote).toHaveBeenCalledTimes(1)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })

  it('skips journal entry for cash method', async () => {
    const cashCompany = makeCompanySettings({ accounting_method: 'cash' })
    enqueue({ data: invoice, error: null })
    enqueue({ data: cashCompany, error: null })

    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-2' })

    // Update invoice status
    enqueue({ data: [{ id: 'inv-1' }], error: null })

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
    enqueue({ data: [{ id: 'inv-1' }], error: null })

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
    enqueue({ data: [{ id: 'inv-1' }], error: null })
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

    enqueue({ data: [{ id: 'inv-1' }], error: null })
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

    // Provider errors map to a safe retryable response without leaking provider text.
    expect(status).toBe(502)
    expect((body.error as unknown as { code: string }).code).toBe('INVOICE_SEND_PROVIDER_FAILED')
    expect((body.error as unknown as { details?: { retryable?: boolean } }).details?.retryable).toBe(true)
  })

  it('renders the final PDF as if already sent (no UTKAST banner)', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-banner' })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })

    enqueue({ data: [{ id: 'inv-1' }], error: null })
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
