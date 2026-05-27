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
}))
import { InvoicePDF } from '@/lib/invoices/pdf-template'

const mockCreateInvoiceJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: (...args: unknown[]) =>
    mockCreateInvoiceJournalEntry(...args),
}))

const mockUploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}))

import { POST } from '../route'

describe('POST /api/invoices/[id]/mark-sent — PDF archival', () => {
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
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockRenderToBuffer.mockResolvedValue(Buffer.from('fake-pdf'))
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
  })

  it('archives the rendered PDF as underlag linked to the journal entry', async () => {
    enqueue({ data: invoice, error: null }) // fetch invoice
    enqueue({ data: null, error: null }) // status update
    enqueue({ data: company, error: null }) // settings
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-7' })
    enqueue({ data: null, error: null }) // update invoice with journal_entry_id

    const request = createMockRequest('/api/invoices/inv-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_id: string | null }>(response)

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

  it('archives the PDF even when journal entry creation fails (non-blocking)', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: company, error: null })
    mockCreateInvoiceJournalEntry.mockRejectedValue(new Error('Period locked'))

    const request = createMockRequest('/api/invoices/inv-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_id: string | null }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBeNull()

    expect(mockUploadDocument).toHaveBeenCalledTimes(1)
    expect(mockUploadDocument).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'company-1',
      expect.objectContaining({ name: 'faktura-F-2026010.pdf' }),
      expect.objectContaining({
        upload_source: 'system',
        journal_entry_id: undefined,
      })
    )
  })

  it('still returns 200 when PDF archival itself fails', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: company, error: null })
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
    enqueue({ data: null, error: null })
    enqueue({ data: company, error: null })

    const request = createMockRequest('/api/invoices/inv-2/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-2' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(mockUploadDocument).not.toHaveBeenCalled()
    expect(mockRenderToBuffer).not.toHaveBeenCalled()
  })

  it('uses kreditfaktura filename when archiving a credit note', async () => {
    const creditNote = makeInvoice({
      id: 'inv-3',
      invoice_number: 'F-2026011',
      status: 'draft',
      credited_invoice_id: 'inv-1',
      customer,
      items: invoice.items,
    })

    enqueue({ data: creditNote, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: company, error: null })
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-9' })
    enqueue({ data: null, error: null })
    // Lookup of the original invoice's number for the credit note PDF
    enqueue({ data: { invoice_number: 'F-2026010' }, error: null })

    const request = createMockRequest('/api/invoices/inv-3/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-3' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockUploadDocument).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'company-1',
      expect.objectContaining({ name: 'kreditfaktura-F-2026011.pdf' }),
      expect.anything()
    )
  })

  it('renders the archived PDF as if already sent (no UTKAST banner)', async () => {
    enqueue({ data: invoice, error: null }) // fetch invoice (status: 'draft')
    enqueue({ data: null, error: null }) // status update
    enqueue({ data: company, error: null }) // settings
    mockCreateInvoiceJournalEntry.mockResolvedValue({ id: 'je-99' })
    enqueue({ data: null, error: null }) // update invoice with journal_entry_id

    const request = createMockRequest('/api/invoices/inv-1/mark-sent', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'inv-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // The in-memory invoice still reads 'draft' after the DB status flip
    // (it's never re-fetched). We must override it before render or
    // pdf-template.tsx prints the "UTKAST – inte en giltig faktura" banner
    // on the archived underlag.
    expect(vi.mocked(InvoicePDF)).toHaveBeenCalledTimes(1)
    const renderArgs = vi.mocked(InvoicePDF).mock.calls[0][0]
    expect(renderArgs.invoice.status).toBe('sent')
    expect(renderArgs.invoice.invoice_number).toBe('F-2026010')
  })
})
