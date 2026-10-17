import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockDownloadDocumentObject = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  downloadDocumentObject: (...args: unknown[]) => mockDownloadDocumentObject(...args),
}))

import {
  MAX_INVOICE_ATTACHMENTS,
  MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES,
  linkInvoiceAttachments,
  loadInvoiceEmailAttachments,
  unlinkInvoiceAttachment,
} from '../invoice-attachments'

const COMPANY = 'company-1'
const INVOICE = 'invoice-1'
const DOC_A = '11111111-1111-4111-8111-111111111111'
const DOC_B = '22222222-2222-4222-8222-222222222222'
const MB = 1024 * 1024

function attachmentRow(documentId: string, fileName: string, size: number, storagePath?: string) {
  return {
    document_id: documentId,
    created_at: '2026-10-16T10:00:00.000Z',
    document: {
      file_name: fileName,
      mime_type: 'application/pdf',
      file_size_bytes: size,
      ...(storagePath ? { storage_path: storagePath } : {}),
    },
  }
}

function documentRow(id: string, size: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    file_name: `${id}.pdf`,
    mime_type: 'application/pdf',
    file_size_bytes: size,
    created_at: '2026-10-16T10:00:00.000Z',
    is_current_version: true,
    ...overrides,
  }
}

describe('linkInvoiceAttachments', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
    supabase = mock.supabase as unknown as SupabaseClient
  })

  it('answers 404 for an invoice outside the company', async () => {
    mock.enqueue({ data: null })

    const result = await linkInvoiceAttachments(supabase, COMPANY, INVOICE, [DOC_A])

    expect(result).toEqual({ ok: false, code: 'INVOICE_NOT_FOUND' })
  })

  it('refuses to change the attachments of a sent invoice', async () => {
    mock.enqueue({ data: { id: INVOICE, status: 'sent' } })

    const result = await linkInvoiceAttachments(supabase, COMPANY, INVOICE, [DOC_A])

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENTS_FIXED' })
    expect(mock.findCall('invoice_attachments', 'insert')).toBeUndefined()
  })

  it('answers a document of another company exactly like a missing one', async () => {
    mock.enqueue({ data: { id: INVOICE, status: 'draft' } })
    mock.enqueue({ data: [] }) // existing attachments
    mock.enqueue({ data: [] }) // the company-scoped document lookup finds nothing

    const result = await linkInvoiceAttachments(supabase, COMPANY, INVOICE, [DOC_A])

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND' })
    expect(mock.findCall('document_attachments', 'eq')).toEqual(['company_id', COMPANY])
    expect(mock.findCall('invoice_attachments', 'insert')).toBeUndefined()
  })

  it('refuses a malformed id without asking the database', async () => {
    const result = await linkInvoiceAttachments(supabase, COMPANY, INVOICE, ['not-a-uuid'])

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND' })
    expect(mock.calls).toHaveLength(0)
  })

  it('refuses a superseded document version', async () => {
    mock.enqueue({ data: { id: INVOICE, status: 'draft' } })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [documentRow(DOC_A, 1000, { is_current_version: false })] })

    const result = await linkInvoiceAttachments(supabase, COMPANY, INVOICE, [DOC_A])

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND' })
  })

  it('refuses a set over the size limit, counting what is already attached', async () => {
    mock.enqueue({ data: { id: INVOICE, status: 'draft' } })
    mock.enqueue({ data: [attachmentRow(DOC_A, 'a.pdf', 20 * MB)] })
    mock.enqueue({ data: [documentRow(DOC_B, 6 * MB)] })

    const result = await linkInvoiceAttachments(supabase, COMPANY, INVOICE, [DOC_B])

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENTS_TOO_LARGE' })
    expect(mock.findCall('invoice_attachments', 'insert')).toBeUndefined()
  })

  it('refuses more files than the limit', async () => {
    const existing = Array.from({ length: MAX_INVOICE_ATTACHMENTS }, (_, i) =>
      attachmentRow(`0000000${i}-0000-4000-8000-000000000000`, `${i}.pdf`, 1000),
    )
    mock.enqueue({ data: { id: INVOICE, status: 'draft' } })
    mock.enqueue({ data: existing })
    mock.enqueue({ data: [documentRow(DOC_B, 1000)] })

    const result = await linkInvoiceAttachments(supabase, COMPANY, INVOICE, [DOC_B])

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENTS_TOO_MANY' })
  })

  it('attaches new documents in order and answers the whole set', async () => {
    mock.enqueue({ data: { id: INVOICE, status: 'draft' } })
    mock.enqueue({ data: [attachmentRow(DOC_A, 'a.pdf', 1000)] })
    mock.enqueue({ data: [documentRow(DOC_B, 2000)] })
    mock.enqueue({ data: null }) // insert
    mock.enqueue({ data: [attachmentRow(DOC_A, 'a.pdf', 1000), attachmentRow(DOC_B, 'b.pdf', 2000)] })

    // DOC_A is already attached: asked again, it is left as it is.
    const result = await linkInvoiceAttachments(supabase, COMPANY, INVOICE, [DOC_A, DOC_B])

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.map((a) => a.document_id)).toEqual([DOC_A, DOC_B])
    expect(mock.findCalls('invoice_attachments', 'insert')).toEqual([
      [{ company_id: COMPANY, invoice_id: INVOICE, document_id: DOC_B }],
    ])
  })

  it('checks without writing on a dry run', async () => {
    mock.enqueue({ data: { id: INVOICE, status: 'draft' } })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [documentRow(DOC_A, 2000)] })

    const result = await linkInvoiceAttachments(supabase, COMPANY, INVOICE, [DOC_A], { dryRun: true })

    expect(result.ok && result.value.map((a) => a.file_name)).toEqual([`${DOC_A}.pdf`])
    expect(mock.findCall('invoice_attachments', 'insert')).toBeUndefined()
  })

  it('maps the database freeze (a draft that was already emailed) to INVOICE_ATTACHMENTS_FIXED', async () => {
    mock.enqueue({ data: { id: INVOICE, status: 'draft' } })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [documentRow(DOC_A, 2000)] })
    mock.enqueue({
      error: { code: '23514', message: 'invoice attachments are fixed once the invoice is issued or emailed' },
    })

    const result = await linkInvoiceAttachments(supabase, COMPANY, INVOICE, [DOC_A])

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENTS_FIXED' })
  })

  it('with nothing asked for, lists the set whatever the invoice state', async () => {
    mock.enqueue({ data: [attachmentRow(DOC_A, 'a.pdf', 1000)] })

    const result = await linkInvoiceAttachments(supabase, COMPANY, INVOICE, [])

    expect(result.ok && result.value.map((a) => a.file_name)).toEqual(['a.pdf'])
  })
})

describe('unlinkInvoiceAttachment', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  let supabase: SupabaseClient

  beforeEach(() => {
    mock = createQueuedMockSupabase()
    supabase = mock.supabase as unknown as SupabaseClient
  })

  it('takes a file off a draft (only the link goes)', async () => {
    mock.enqueue({ data: { id: INVOICE, status: 'draft' } })
    mock.enqueue({ data: [{ id: 'link-1' }] })

    const result = await unlinkInvoiceAttachment(supabase, COMPANY, INVOICE, DOC_A)

    expect(result).toEqual({ ok: true, value: null })
    expect(mock.findCall('invoice_attachments', 'delete')).toEqual([])
    expect(mock.findCall('document_attachments', 'delete')).toBeUndefined()
  })

  it('refuses once the invoice is sent', async () => {
    mock.enqueue({ data: { id: INVOICE, status: 'paid' } })

    const result = await unlinkInvoiceAttachment(supabase, COMPANY, INVOICE, DOC_A)

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENTS_FIXED' })
    expect(mock.findCall('invoice_attachments', 'delete')).toBeUndefined()
  })

  it('maps the database retention refusal to INVOICE_ATTACHMENTS_FIXED', async () => {
    mock.enqueue({ data: { id: INVOICE, status: 'draft' } })
    mock.enqueue({
      error: { code: '23514', message: 'retention: an issued or emailed invoice keeps the files it was sent with' },
    })

    const result = await unlinkInvoiceAttachment(supabase, COMPANY, INVOICE, DOC_A)

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENTS_FIXED' })
  })

  it('answers 404 for a file that is not attached', async () => {
    mock.enqueue({ data: { id: INVOICE, status: 'draft' } })
    mock.enqueue({ data: [] })

    const result = await unlinkInvoiceAttachment(supabase, COMPANY, INVOICE, DOC_A)

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENT_NOT_FOUND' })
  })
})

describe('loadInvoiceEmailAttachments', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
    supabase = mock.supabase as unknown as SupabaseClient
  })

  it('is empty, and reads nothing from storage, for an invoice without files', async () => {
    mock.enqueue({ data: [] })

    const result = await loadInvoiceEmailAttachments(supabase, COMPANY, INVOICE)

    expect(result).toEqual({ ok: true, value: [] })
    expect(mockDownloadDocumentObject).not.toHaveBeenCalled()
  })

  it('reads every file in order with its original name', async () => {
    mock.enqueue({
      data: [
        attachmentRow(DOC_A, 'tidrapport juli.pdf', 10, 'company-1/a.pdf'),
        { ...attachmentRow(DOC_B, 'kvitto.jpg', 4, 'company-1/b.jpg'), document: { file_name: 'kvitto.jpg', mime_type: 'image/jpeg', file_size_bytes: 4, storage_path: 'company-1/b.jpg' } },
      ],
    })
    mockDownloadDocumentObject
      .mockResolvedValueOnce({ blob: new Blob(['%PDF-1.7']), error: null })
      .mockResolvedValueOnce({ blob: new Blob(['jpeg']), error: null })

    const result = await loadInvoiceEmailAttachments(supabase, COMPANY, INVOICE)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map((f) => [f.filename, f.contentType])).toEqual([
      ['tidrapport juli.pdf', 'application/pdf'],
      ['kvitto.jpg', 'image/jpeg'],
    ])
    expect(result.value[0]!.content.toString()).toBe('%PDF-1.7')
    expect(mockDownloadDocumentObject).toHaveBeenCalledWith(supabase, 'company-1/a.pdf', COMPANY)
  })

  it('stops the send when a file cannot be read', async () => {
    mock.enqueue({ data: [attachmentRow(DOC_A, 'a.pdf', 10, 'company-1/a.pdf')] })
    mockDownloadDocumentObject.mockResolvedValueOnce({ blob: null, error: { message: 'not found' } })

    const result = await loadInvoiceEmailAttachments(supabase, COMPANY, INVOICE)

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENT_LOAD_FAILED' })
  })

  it('refuses by stored size before reading anything', async () => {
    mock.enqueue({
      data: [attachmentRow(DOC_A, 'a.pdf', MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES + 1, 'company-1/a.pdf')],
    })

    const result = await loadInvoiceEmailAttachments(supabase, COMPANY, INVOICE)

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENTS_TOO_LARGE' })
    expect(mockDownloadDocumentObject).not.toHaveBeenCalled()
  })

  it('refuses by the bytes actually read when the metadata understates them', async () => {
    mock.enqueue({ data: [attachmentRow(DOC_A, 'a.pdf', 10, 'company-1/a.pdf')] })
    mockDownloadDocumentObject.mockResolvedValueOnce({
      blob: new Blob([new Uint8Array(MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES + 1)]),
      error: null,
    })

    const result = await loadInvoiceEmailAttachments(supabase, COMPANY, INVOICE)

    expect(result).toEqual({ ok: false, code: 'INVOICE_ATTACHMENTS_TOO_LARGE' })
  })
})
