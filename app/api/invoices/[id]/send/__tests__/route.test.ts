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
// The sender resolver reads company_sending_domains; keep it out of the
// queued-mock sequence (its own tests live in lib/email/__tests__).
vi.mock('@/lib/email/invoice-sender', () => ({
  resolveInvoiceSender: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({
    sendEmail: (...args: unknown[]) => mockSendEmail(...args),
    isConfigured: () => mockIsConfigured(),
  }),
}))

const mockSendTrackedInvoiceEmail = vi.fn(async (input: {
  emailService: { sendEmail: (options: unknown) => Promise<Record<string, unknown>> }
  to: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  subject: string
  html: string
  text: string
  replyTo?: string
  fromName?: string
  filename: string
  pdfBuffer: Buffer
}) => ({
  ...(await input.emailService.sendEmail({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
    fromName: input.fromName,
    attachments: [{
      filename: input.filename,
      content: input.pdfBuffer,
      contentType: 'application/pdf',
    }],
  })),
  deliveryId: 'delivery-1',
  documentId: 'document-1',
}))
const mockReserveInvoiceDelivery = vi.fn().mockResolvedValue('delivery-1')
vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  InvoiceDeliverySnapshotError: class InvoiceDeliverySnapshotError extends Error {},
  reserveInvoiceDelivery: (...args: unknown[]) => mockReserveInvoiceDelivery(...args),
  sendTrackedInvoiceEmail: (...args: unknown[]) => mockSendTrackedInvoiceEmail(...args as [never]),
}))

const mockLinkToJournalEntry = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: (...args: unknown[]) => mockLinkToJournalEntry(...args),
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

const mockCreateSchedules = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/from-invoices', () => ({
  createSchedulesForCustomerInvoice: (...args: unknown[]) => mockCreateSchedules(...args),
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
  const company = makeCompanySettings({ accounting_method: 'accrual', bankgiro: '123-4567' })
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
    mockCreateSchedules.mockResolvedValue({ created: 0, failed: 0 })
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

  it('returns 400 when the stored customer email is malformed', async () => {
    enqueue({
      data: makeInvoice({
        id: 'inv-1',
        customer: makeCustomer({ email: 'not-an-email' }),
        items: [],
      }),
      error: null,
    })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_SEND_NO_CUSTOMER_EMAIL')
    expect(mockReserveInvoiceDelivery).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
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

  it.each(['SEK', 'EUR'] as const)(
    'does not allocate a number or send a %s invoice without a matching payment account',
    async (currency) => {
    const invoiceWithoutAccount = makeInvoice({
      ...invoice,
      invoice_number: null,
      currency,
    })
    enqueue({ data: invoiceWithoutAccount, error: null })
    enqueue({
      data: {
        ...company,
        invoice_payment_accounts: {},
        clearing_number: null,
        account_number: null,
        bankgiro: null,
        plusgiro: null,
        swish: null,
        iban: null,
      },
      error: null,
    })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')
    expect(mockReserveInvoiceDelivery).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
    },
  )

  it('rejects custom recipients from a non-admin company member before allocation', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })
    enqueue({ data: { role: 'member' }, error: null })

    const request = createMockRequest('/api/invoices/inv-1/send', {
      method: 'POST',
      body: { additional_cc: ['external@test.se'] },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(mockReserveInvoiceDelivery).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('rejects a custom recipient collision before allocation', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })
    enqueue({ data: { role: 'admin' }, error: null })

    const request = createMockRequest('/api/invoices/inv-1/send', {
      method: 'POST',
      body: { additional_cc: ['KUND@test.se'] },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { collisions: Array<{ conflicts_with: string }> } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.collisions).toEqual([
      expect.objectContaining({ conflicts_with: 'to' }),
    ])
    expect(mockReserveInvoiceDelivery).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('rejects a combined recipient set over the limit before allocation', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({
      data: {
        ...company,
        invoice_email_cc_addresses: Array.from(
          { length: 19 },
          (_, index) => `fixed-${index}@test.se`,
        ),
        invoice_email_bcc_addresses: [],
      },
      error: null,
    })
    enqueue({ data: { role: 'admin' }, error: null })

    const request = createMockRequest('/api/invoices/inv-1/send', {
      method: 'POST',
      body: { additional_bcc: ['archive@test.se'] },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { recipient_count: number } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_SEND_TOO_MANY_RECIPIENTS')
    expect(body.error.details.recipient_count).toBe(21)
    expect(mockReserveInvoiceDelivery).not.toHaveBeenCalled()
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('generate_invoice_number', expect.anything())
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('rejects fixed routing over the total limit without a custom-recipient role query', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({
      data: {
        ...company,
        email: 'legacy@test.se',
        invoice_email_cc_addresses: Array.from(
          { length: 19 },
          (_, index) => `fixed-${index}@test.se`,
        ),
        invoice_email_bcc_addresses: ['archive@test.se'],
      },
      error: null,
    })

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { recipient_count: number } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_SEND_TOO_MANY_RECIPIENTS')
    expect(body.error.details.recipient_count).toBe(21)
    expect(mockReserveInvoiceDelivery).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('sends invoice email, updates status, creates journal entry for accrual', async () => {
    // Fetch invoice
    enqueue({ data: invoice, error: null })
    // Fetch company settings
    enqueue({
      data: {
        ...company,
        invoice_email_cc_addresses: ['fixed-copy@test.se'],
        invoice_email_bcc_addresses: ['fixed-archive@test.se'],
      },
      error: null,
    })
    // Authorize the per-send CC and BCC additions.
    enqueue({ data: { role: 'owner' }, error: null })

    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Update invoice status to 'sent' (optimistic lock: returns the matched row)
    enqueue({ data: [{ id: 'inv-1' }], error: null })
    // Update invoice with journal_entry_id
    enqueue({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/invoices/inv-1/send', {
      method: 'POST',
      body: {
        additional_cc: ['case-owner@test.se'],
        additional_bcc: ['extra-archive@test.se'],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      messageId: string
      recipient_counts: { to: number; cc: number }
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.messageId).toBe('msg-1')
    expect(body.recipient_counts).toEqual({ to: 1, cc: 2 })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockSendTrackedInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        invoiceId: 'inv-1',
        cc: ['fixed-copy@test.se', 'case-owner@test.se'],
        bcc: ['fixed-archive@test.se', 'extra-archive@test.se'],
      }),
    )
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['kund@test.se'],
        cc: ['fixed-copy@test.se', 'case-owner@test.se'],
        bcc: ['fixed-archive@test.se', 'extra-archive@test.se'],
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
      currency: 'EUR',
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
    expect(InvoicePDF).toHaveBeenCalledWith(
      expect.objectContaining({ originalInvoiceNumber: 'F-2024001' }),
    )
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            filename: 'Test Firma x Test AB Kreditfaktura nr KR-F-2024001 20240615.pdf',
          }),
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
    const cashCompany = makeCompanySettings({ accounting_method: 'cash', bankgiro: '123-4567' })
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

  it('does not call the provider when delivery history cannot be saved', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })
    mockSendTrackedInvoiceEmail.mockRejectedValueOnce(new Error('snapshot insert failed'))

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: unknown }>(response)

    expect(status).toBe(500)
    expect((body.error as { code: string }).code).toBe('INVOICE_SEND_SNAPSHOT_FAILED')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('does not allocate an invoice number when delivery reservation fails', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })
    mockReserveInvoiceDelivery.mockRejectedValueOnce(new Error('reservation failed'))

    const request = createMockRequest('/api/invoices/inv-1/send', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INVOICE_SEND_SNAPSHOT_FAILED')
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('generate_invoice_number', expect.anything())
    expect(mockSendTrackedInvoiceEmail).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('returns 400 on malformed lines before any email is sent', async () => {
    enqueue({ data: invoice, error: null }) // ownership fetch precedes validation
    const request = createMockRequest('/api/invoices/inv-1/send', {
      method: 'POST',
      body: { lines: [{ account_number: 'bad', debit_amount: -1 }] },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('returns 400 on unbalanced lines before any email is sent', async () => {
    enqueue({ data: invoice, error: null })
    const request = createMockRequest('/api/invoices/inv-1/send', {
      method: 'POST',
      body: {
        lines: [
          { account_number: '1510', debit_amount: 100, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 90 },
        ],
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_MARK_SENT_LINES_UNBALANCED')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('books user-edited lines verbatim and skips accrual schedules', async () => {
    enqueue({ data: invoice, error: null }) // fetch invoice
    enqueue({ data: company, error: null }) // settings
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-lines' })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-20' })
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // status flip
    enqueue({ data: null, error: null }) // journal_entry_id link

    const lines = [
      { account_number: '1510', debit_amount: 12500, credit_amount: 0 },
      { account_number: '3041', debit_amount: 0, credit_amount: 10000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
    ]
    const request = createMockRequest('/api/invoices/inv-1/send', {
      method: 'POST',
      body: { lines },
    })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    // User-edited lines book exactly as reviewed: no accrual schedules.
    expect(mockCreateSchedules).not.toHaveBeenCalled()
    expect(mockCreateInvoiceJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'inv-1' }),
      'enskild_firma',
      undefined,
      expect.objectContaining({
        customLines: [
          expect.objectContaining({ account_number: '1510', debit_amount: 12500 }),
          expect.objectContaining({ account_number: '3041', credit_amount: 10000 }),
          expect.objectContaining({ account_number: '2611', credit_amount: 2500 }),
        ],
      })
    )
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
