import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import { receiptImage } from '@/tests/fixtures/receipt-images'

// Mocks. extract-invoice-fields is the AI call we want to assert is NOT
// invoked when the gate trips. uploadDocument is the storage write: we
// short-circuit it to a synthetic doc row.
vi.mock('@/lib/documents/inbox-extraction/extract-invoice-fields', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/documents/inbox-extraction/extract-invoice-fields')
  >('@/lib/documents/inbox-extraction/extract-invoice-fields')
  return {
    ...actual,
    extractInvoiceFields: vi.fn(),
  }
})

vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn().mockResolvedValue({ id: 'doc-1' }),
}))

// The staged (deferred) upload path only exists when AI is configured on this
// deployment: an unconfigured one skips synchronously (ai_unconfigured). These
// tests simulate a configured deployment; the model call itself is mocked.
vi.mock('@/lib/ai', () => ({
  getAiStatus: () => ({
    provider: 'bedrock',
    configured: true,
    reason: 'ok',
    capabilities: { pdfNative: true, imageInput: true, toolUse: true, forcedToolChoice: true, strictJsonSchema: false },
    models: { assistant: 'm', heavy: 'm', extraction: 'm' },
    pdfMode: 'native',
    assistantAvailable: true,
  }),
}))

vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))

// Paid AI OCR gate: hasCapability('ai') decides whether Bedrock runs. Default
// to entitled (true) so these page-count tests exercise the page-count reason,
// not the no-AI one; the no-AI path is covered in sandbox-skip-extraction.test.ts.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

// The deferred extraction worker builds its own cookieless service client
// (the request-scoped one may be gone once the response is flushed). Route
// it to the same mock supabase so the CAS flip is observable.
// Match on arrival runs after the flip; its own reads and writes are tested
// in lib/documents/bank-match, not by this file's hand-built client.
vi.mock('@/lib/operations/inbox-bank-match', () => ({ proposeBankMatchForInboxItem: vi.fn() }))
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return { ...actual, createServiceClientNoCookies: vi.fn() }
})

import { extractInvoiceFields, emptyResult } from '@/lib/documents/inbox-extraction/extract-invoice-fields'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { processArchivedDocument, uploadAndExtract } from '../lib/upload-and-extract'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { proposeBankMatchForInboxItem } from '@/lib/operations/inbox-bank-match'

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find(
    (r) => r.method === method && r.path === path,
  )!
}

const uploadRoute = findRoute('POST', '/upload')

interface FlipCapture {
  payload?: Record<string, unknown>
  filters: Array<[string, unknown]>
}

// Build the supabase mock the upload handler and the deferred worker need:
//   .from('invoice_inbox_items').insert(row).select('*').single() → { data: row, error: null }
//   .from('invoice_inbox_items').update(p).eq().eq().select('id') → CAS flip (captured)
//   .from('suppliers').select().eq().eq()... .maybeSingle() → { data: null }
function makeSupabase(
  captured: { row?: Record<string, unknown> },
  flip: FlipCapture = { filters: [] },
  // The row's reading when the worker reads it before the flip (a person
  // may have chosen a purchase category meanwhile). Undefined: no read path.
  currentReading?: Record<string, unknown> | null,
) {
  const supplierChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  }
  const updateChain = {
    eq: vi.fn((...args: [string, unknown]) => {
      flip.filters.push(args)
      return updateChain
    }),
    select: vi.fn().mockResolvedValue({ data: [{ id: 'inbox-1' }], error: null }),
  }
  const inboxChain = {
    insert: vi.fn((row: Record<string, unknown>) => {
      captured.row = row
      return {
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'inbox-1', status: 'received', matched_supplier_id: null, ...row },
            error: null,
          }),
        }),
      }
    }),
    update: vi.fn((payload: Record<string, unknown>) => {
      flip.payload = payload
      return updateChain
    }),
    ...(currentReading !== undefined
      ? {
          select: vi.fn(() => {
            const read = {
              eq: vi.fn(() => read),
              maybeSingle: vi.fn().mockResolvedValue({ data: { extracted_data: currentReading }, error: null }),
            }
            return read
          }),
        }
      : {}),
  }
  return {
    from: vi.fn((table: string) => {
      if (table === 'invoice_inbox_items') return inboxChain
      return supplierChain
    }),
  }
}

function buildCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as ExtensionContext
}

// The last page gets a distinct size so tests can assert the slice kept it:
// slicePdfForExtraction takes the first pages PLUS the last (totals page).
async function makePdfBuffer(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pageCount - 1; i++) pdf.addPage([612, 792])
  pdf.addPage([400, 600])
  return pdf.save()
}

// createMockRequest hard-codes application/json: build the multipart Request
// directly so the formData() parse on the server side succeeds.
function makeMultipartRequest(form: FormData): Request {
  return new Request('http://localhost:3000/upload', {
    method: 'POST',
    body: form,
  })
}

async function makeUploadRequest(pageCount: number): Promise<Request> {
  const bytes = await makePdfBuffer(pageCount)
  const file = new File([bytes as BlobPart], `${pageCount}-page.pdf`, { type: 'application/pdf' })
  const form = new FormData()
  form.set('file', file)
  return makeMultipartRequest(form)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('detected receipt MIME propagation', () => {
  it.each([
    { source: 'multipart', deferred: false },
    { source: 'multipart', deferred: true },
    { source: 'signed', deferred: false },
    { source: 'signed', deferred: true },
  ])('uses archived MIME for $source extraction (deferred=$deferred)', async ({ source, deferred }) => {
    const buffer = receiptImage('jpeg')
    const file = { name: 'receipt.png', buffer, type: 'image/png' }
    const document = { id: 'doc-1', mime_type: 'image/jpeg' }
    const supabase = makeSupabase({})
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({ data: emptyResult(), rawText: 'ok' })
    if (source === 'multipart') {
      vi.mocked(uploadDocument).mockResolvedValueOnce(document as never)
      await uploadAndExtract(supabase as never, 'user-1', 'company-1', file, 'upload', undefined, undefined, {
        deferExtraction: deferred,
      })
    } else {
      await processArchivedDocument(supabase as never, 'user-1', 'company-1', document, file, 'upload', undefined, undefined, {
        deferExtraction: deferred,
      })
    }
    await vi.waitFor(() => expect(extractInvoiceFields).toHaveBeenCalledOnce())
    expect(extractInvoiceFields).toHaveBeenCalledWith(expect.objectContaining({
      buffer: Buffer.from(buffer), mimeType: 'image/jpeg', fileName: 'receipt.png',
    }))
    expect(appendProcessingHistory).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'DocumentIngested', payload: expect.objectContaining({ mime_type: 'image/jpeg' }),
    }))
  })
})

describe('the mail a document came with reaches its reading (crm#1749)', () => {
  it.each([false, true])('passes the subject and received time to the extraction (deferred=%s)', async (deferred) => {
    const supabase = makeSupabase({})
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(uploadDocument).mockResolvedValueOnce({ id: 'doc-1', mime_type: 'image/jpeg' } as never)
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({ data: emptyResult(), rawText: 'ok' })
    const file = { name: 'invoice.jpg', buffer: receiptImage('jpeg'), type: 'image/jpeg' }
    const mail = { from: 'billing@example.com', subject: 'Your invoice of Nov 7, 2026', receivedAt: '2026-11-07T07:41:00.000Z' }

    await uploadAndExtract(supabase as never, 'user-1', 'company-1', file, 'email', mail, undefined, { deferExtraction: deferred })

    await vi.waitFor(() => expect(extractInvoiceFields).toHaveBeenCalledOnce())
    expect(extractInvoiceFields).toHaveBeenCalledWith(expect.objectContaining({
      emailContext: { subject: 'Your invoice of Nov 7, 2026', receivedAt: '2026-11-07T07:41:00.000Z' },
    }))
  })

  it('gives an upload without a mail no email context', async () => {
    const supabase = makeSupabase({})
    vi.mocked(uploadDocument).mockResolvedValueOnce({ id: 'doc-1', mime_type: 'image/jpeg' } as never)
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({ data: emptyResult(), rawText: 'ok' })
    const file = { name: 'receipt.jpg', buffer: receiptImage('jpeg'), type: 'image/jpeg' }

    await uploadAndExtract(supabase as never, 'user-1', 'company-1', file, 'upload')

    expect(extractInvoiceFields).toHaveBeenCalledWith(expect.objectContaining({
      emailContext: { subject: null, receivedAt: null },
    }))
  })
})

describe('POST /upload: staged extraction + page-count gate (issue #553)', () => {
  it('defers long PDFs: responds processing, then slices to 8 pages (incl. the last) and flips to received', async () => {
    const captured: { row?: Record<string, unknown> } = {}
    const flip: FlipCapture = { filters: [] }
    const supabase = makeSupabase(captured, flip)
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({
      data: emptyResult(),
      rawText: 'ok',
    })

    const req = await makeUploadRequest(10)
    const res = await uploadRoute.handler(req, buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    // The response is the receipt ack: the row exists, extraction has not
    // landed, nothing is reported skipped.
    expect(status).toBe(200)
    expect(body.data.status).toBe('processing')
    expect(body.data.extracted_data).toBeNull()
    expect(body.data.extraction_skipped).toBe(false)
    expect(body.data.skip_reason).toBeNull()
    expect(body.data.page_count).toBe(10)
    expect(captured.row?.status).toBe('processing')
    expect(captured.row?.extracted_data).toBeNull()
    expect(captured.row?.extraction_skipped).toBe(false)

    // The deferred worker extracts from the sliced copy, not the original:
    // the first 7 pages plus the LAST page (the distinct 400x600 one), where
    // invoice totals usually sit.
    await vi.waitFor(() => expect(extractInvoiceFields).toHaveBeenCalledOnce())
    const sentBuffer = vi.mocked(extractInvoiceFields).mock.calls[0][0].buffer
    const sentPdf = await PDFDocument.load(sentBuffer)
    expect(sentPdf.getPageCount()).toBe(8)
    const lastPage = sentPdf.getPage(7).getSize()
    expect(lastPage).toEqual({ width: 400, height: 600 })

    // ...and CAS-flips the processing row to received, with the truncation
    // recorded in extracted_data.pages rather than as a skip.
    await vi.waitFor(() => expect(flip.payload).toBeDefined())
    expect(flip.payload?.status).toBe('received')
    expect(flip.payload?.extraction_skipped).toBe(false)
    expect((flip.payload?.extracted_data as { pages?: unknown })?.pages).toEqual({
      total: 10,
      analyzed: 8,
    })
    expect(flip.filters).toEqual([
      ['id', 'inbox-1'],
      ['status', 'processing'],
    ])
  })

  it('defers PDFs at or below the native page budget (6 pages) and extracts the full buffer', async () => {
    const captured: { row?: Record<string, unknown> } = {}
    const flip: FlipCapture = { filters: [] }
    const supabase = makeSupabase(captured, flip)
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({
      data: emptyResult(),
      rawText: 'ok',
    })

    // 6 pages gated on the old budget of 3; on the native budget of 8 the
    // whole document is read (this is the regression the raise fixes).
    const req = await makeUploadRequest(6)
    const res = await uploadRoute.handler(req, buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(body.data.status).toBe('processing')
    expect(body.data.extraction_skipped).toBe(false)
    expect(body.data.skip_reason).toBeNull()
    expect(body.data.page_count).toBe(6)

    await vi.waitFor(() => expect(extractInvoiceFields).toHaveBeenCalledOnce())
    const sentBuffer = vi.mocked(extractInvoiceFields).mock.calls[0][0].buffer
    const sentPdf = await PDFDocument.load(sentBuffer)
    expect(sentPdf.getPageCount()).toBe(6)

    await vi.waitFor(() => expect(flip.payload).toBeDefined())
    expect(flip.payload?.status).toBe('received')
    // No slice happened, so no pages truncation marker.
    expect((flip.payload?.extracted_data as { pages?: unknown })?.pages).toBeUndefined()
  })
})

describe('POST /upload: the deferred worker keeps a person\'s purchase category', () => {
  it('carries a choice made while the row waited onto the flipped reading', async () => {
    const captured: { row?: Record<string, unknown> } = {}
    const flip: FlipCapture = { filters: [] }
    const choice = { code: 'expense.office.supplies', source: 'person', set_at: '2026-10-15T09:00:00.000Z', set_via: 'dashboard' }
    const supabase = makeSupabase(captured, flip, { totals: { total: 1 }, purchaseCategory: choice })
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({ data: emptyResult(), rawText: 'ok' })

    const res = await uploadRoute.handler(await makeUploadRequest(6), buildCtx(supabase))
    expect(res.status).toBe(200)

    await vi.waitFor(() => expect(flip.payload).toBeDefined())
    expect((flip.payload?.extracted_data as { purchaseCategory?: unknown }).purchaseCategory).toEqual(choice)
    // Then the bank is checked for the item's payment, with the worker's client.
    await vi.waitFor(() => expect(proposeBankMatchForInboxItem).toHaveBeenCalledWith(supabase, 'company-1', 'inbox-1'))
  })
})

