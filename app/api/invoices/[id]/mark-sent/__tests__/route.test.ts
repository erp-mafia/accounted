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

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
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

const mockCreateInvoiceJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: (...args: unknown[]) =>
    mockCreateInvoiceJournalEntry(...args),
}))

const mockIssueCreditNote = vi.fn()
vi.mock('@/lib/invoices/issue-credit-note', () => ({
  issueCreditNote: (...args: unknown[]) => mockIssueCreditNote(...args),
  creditNoteNeedsJournalEntry: (method: string, original: { status: string; journal_entry_id?: string | null; paid_at?: string | null; paid_amount?: number | null }) =>
    method === 'accrual' ||
    !!original.journal_entry_id ||
    original.status === 'paid' ||
    !!original.paid_at ||
    Math.abs(original.paid_amount ?? 0) > 0,
}))

const mockUploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}))

import { POST } from '../route'

describe('POST /api/invoices/[id]/mark-sent: PDF archival', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const customer = makeCustomer({ id: 'cust-1', email: 'kund@test.se' })
  const company = makeCompanySettings({
    accounting_method: 'accrual',
    entity_type: 'enskild_firma',
  })
  const invoice = makeInvoice({
    id: 'inv-1',
    invoice_number: 'F-2026010',
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
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
    mockRenderToBuffer.mockResolvedValue(Buffer.from('fake-pdf'))
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
    mockIssueCreditNote.mockResolvedValue({
      complete: true,
      journalEntryId: 'credit-je-1',
      journalEntryRequired: true,
      failures: [],
    })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    })

    const request = createMockRequest('/api/invoices/inv-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 404 when the invoice does not exist', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const request = createMockRequest('/api/invoices/missing/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'missing' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('returns 400 when the invoice is not a draft', async () => {
    enqueue({ data: makeInvoice({ id: 'inv-1', status: 'sent' }), error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('archives the rendered PDF as underlag linked to the journal entry', async () => {
    enqueue({ data: invoice, error: null }) // fetch invoice
    enqueue({ data: company, error: null }) // settings
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // status update
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-7' })
    enqueue({ data: null, error: null }) // update invoice with journal_entry_id

    const request = createMockRequest('/api/invoices/inv-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string | null
      partial?: boolean
      partial_failures?: Array<{ step: string }>
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-7')

    expect(mockRenderToBuffer).toHaveBeenCalledTimes(1)
    expect(mockUploadDocument).toHaveBeenCalledTimes(1)
    expect(mockUploadDocument).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'company-1',
      expect.objectContaining({
        name: 'faktura-F-2026010.pdf',
        type: 'application/pdf',
      }),
      expect.objectContaining({
        upload_source: 'system',
        journal_entry_id: 'je-7',
      })
    )
  })

  it('restores the draft and fails closed when journal entry creation fails', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })
    enqueue({ data: [{ id: 'inv-1' }], error: null })
    mockCreateInvoiceJournalEntry.mockRejectedValue(new Error('Period locked'))

    const request = createMockRequest('/api/invoices/inv-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INVOICE_MARK_SENT_BOOK_FAILED')
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it('still returns 200 when PDF archival itself fails', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })
    enqueue({ data: [{ id: 'inv-1' }], error: null })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-8' })
    enqueue({ data: null, error: null })

    mockUploadDocument.mockRejectedValue(new Error('Storage offline'))

    const request = createMockRequest('/api/invoices/inv-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('skips PDF archival for proforma invoices', async () => {
    const proforma = makeInvoice({
      id: 'inv-2',
      invoice_number: 'PF-2026005',
      status: 'draft',
      document_type: 'proforma',
      customer,
      items: invoice.items,
    })

    enqueue({ data: proforma, error: null })
    enqueue({ data: company, error: null })
    enqueue({ data: [{ id: 'inv-2' }], error: null })

    const request = createMockRequest('/api/invoices/inv-2/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-2' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(mockUploadDocument).not.toHaveBeenCalled()
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })

  it('issues the credit note and uses a credit-note filename when archiving it', async () => {
    const creditNote = makeInvoice({
      id: 'inv-3',
      invoice_number: 'KR-F-2026010',
      status: 'draft',
      credited_invoice_id: 'inv-1',
      customer,
      items: invoice.items,
    })

    enqueue({ data: creditNote, error: null })
    enqueue({ data: company, error: null })
    const original = {
      id: 'inv-1',
      invoice_number: 'F-2026010',
      status: 'sent',
      journal_entry_id: 'original-je-1',
      paid_at: null,
      paid_amount: null,
      total: 12500,
    }
    enqueue({ data: original, error: null })
    enqueue({ data: [{ id: 'inv-3' }], error: null })

    const request = createMockRequest('/api/invoices/inv-3/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-3' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockIssueCreditNote).toHaveBeenCalledWith(
      expect.objectContaining({
        creditNote: expect.objectContaining({ id: 'inv-3' }),
        originalInvoice: original,
        accountingMethod: 'accrual',
      }),
    )
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
    expect(mockUploadDocument).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'company-1',
      expect.objectContaining({ name: 'kreditfaktura-KR-F-2026010.pdf' }),
      expect.anything()
    )
  })

  it('fails closed and restores the draft when credit-note booking cannot start', async () => {
    const creditNote = makeInvoice({
      id: 'credit-1',
      invoice_number: 'KR-F-2026010',
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
        invoice_number: 'F-2026010',
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

    const request = createMockRequest('/api/invoices/credit-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'credit-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it('repairs a sent credit note without running the draft status transition again', async () => {
    const creditNote = makeInvoice({
      id: 'credit-1',
      invoice_number: 'KR-F-2026010',
      status: 'sent',
      credited_invoice_id: 'inv-1',
      journal_entry_id: null,
      customer,
      items: invoice.items,
    })
    enqueue({ data: creditNote, error: null })
    enqueue({ data: company, error: null })
    enqueue({
      data: {
        id: 'inv-1',
        invoice_number: 'F-2026010',
        status: 'sent',
        journal_entry_id: 'original-je-1',
        paid_at: null,
        paid_amount: null,
        total: 12500,
      },
      error: null,
    })

    const request = createMockRequest('/api/invoices/credit-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'credit-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockIssueCreditNote).toHaveBeenCalledOnce()
  })

  it('returns 409 when another request already marked the draft as sent', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/invoices/inv-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(409)
    expect(mockCreateInvoiceJournalEntry).not.toHaveBeenCalled()
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it('renders the archived PDF as if already sent (no UTKAST banner)', async () => {
    enqueue({ data: invoice, error: null }) // fetch invoice (status: 'draft')
    enqueue({ data: company, error: null }) // settings
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // status update
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-99' })
    enqueue({ data: null, error: null }) // update invoice with journal_entry_id

    const request = createMockRequest('/api/invoices/inv-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // The in-memory invoice still reads 'draft' after the DB status flip
    // (it's never re-fetched). We must override it before render or
    // pdf-template.tsx prints the "UTKAST: inte en giltig faktura" banner
    // on the archived underlag.
    expect(vi.mocked(InvoicePDF)).toHaveBeenCalledTimes(1)
    const renderArgs = vi.mocked(InvoicePDF).mock.calls[0][0]
    expect(renderArgs.invoice.status).toBe('sent')
    expect(renderArgs.invoice.invoice_number).toBe('F-2026010')
  })
})
