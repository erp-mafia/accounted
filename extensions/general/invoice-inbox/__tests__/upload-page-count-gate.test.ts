import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

// Mocks. extract-invoice-fields is the AI call we want to assert is NOT
// invoked when the gate trips. uploadDocument is the storage write: we
// short-circuit it to a synthetic doc row.
vi.mock('@/extensions/general/invoice-inbox/lib/extract-invoice-fields', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/invoice-inbox/lib/extract-invoice-fields')
  >('@/extensions/general/invoice-inbox/lib/extract-invoice-fields')
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
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return { ...actual, createServiceClientNoCookies: vi.fn() }
})

import { extractInvoiceFields, emptyResult } from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'

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
    storage: { from: vi.fn() } as unknown as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as ExtensionContext
}

async function makePdfBuffer(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pageCount; i++) pdf.addPage([612, 792])
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

describe('POST /upload: staged extraction + page-count gate (issue #553)', () => {
  it('defers long PDFs: responds processing, then slices to 3 pages and flips to received', async () => {
    const captured: { row?: Record<string, unknown> } = {}
    const flip: FlipCapture = { filters: [] }
    const supabase = makeSupabase(captured, flip)
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({
      data: emptyResult(),
      rawText: 'ok',
    })

    const req = await makeUploadRequest(6)
    const res = await uploadRoute.handler(req, buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    // The response is the receipt ack: the row exists, extraction has not
    // landed, nothing is reported skipped.
    expect(status).toBe(200)
    expect(body.data.status).toBe('processing')
    expect(body.data.extracted_data).toBeNull()
    expect(body.data.extraction_skipped).toBe(false)
    expect(body.data.skip_reason).toBeNull()
    expect(body.data.page_count).toBe(6)
    expect(captured.row?.status).toBe('processing')
    expect(captured.row?.extracted_data).toBeNull()
    expect(captured.row?.extraction_skipped).toBe(false)

    // The deferred worker extracts from the sliced copy, not the original.
    await vi.waitFor(() => expect(extractInvoiceFields).toHaveBeenCalledOnce())
    const sentBuffer = vi.mocked(extractInvoiceFields).mock.calls[0][0].buffer
    const sentPdf = await PDFDocument.load(sentBuffer)
    expect(sentPdf.getPageCount()).toBe(3)

    // ...and CAS-flips the processing row to received, with the truncation
    // recorded in extracted_data.pages rather than as a skip.
    await vi.waitFor(() => expect(flip.payload).toBeDefined())
    expect(flip.payload?.status).toBe('received')
    expect(flip.payload?.extraction_skipped).toBe(false)
    expect((flip.payload?.extracted_data as { pages?: unknown })?.pages).toEqual({
      total: 6,
      analyzed: 3,
    })
    expect(flip.filters).toEqual([
      ['id', 'inbox-1'],
      ['status', 'processing'],
    ])
  })

  it('defers PDFs at or below the page-count limit and extracts the full buffer', async () => {
    const captured: { row?: Record<string, unknown> } = {}
    const flip: FlipCapture = { filters: [] }
    const supabase = makeSupabase(captured, flip)
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({
      data: emptyResult(),
      rawText: 'ok',
    })

    const req = await makeUploadRequest(2)
    const res = await uploadRoute.handler(req, buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(body.data.status).toBe('processing')
    expect(body.data.extraction_skipped).toBe(false)
    expect(body.data.skip_reason).toBeNull()
    expect(body.data.page_count).toBe(2)

    await vi.waitFor(() => expect(extractInvoiceFields).toHaveBeenCalledOnce())
    const sentBuffer = vi.mocked(extractInvoiceFields).mock.calls[0][0].buffer
    const sentPdf = await PDFDocument.load(sentBuffer)
    expect(sentPdf.getPageCount()).toBe(2)

    await vi.waitFor(() => expect(flip.payload).toBeDefined())
    expect(flip.payload?.status).toBe('received')
    // No slice happened, so no pages truncation marker.
    expect((flip.payload?.extracted_data as { pages?: unknown })?.pages).toBeUndefined()
  })

  it('honors client-side skip_extraction=true synchronously with skip_reason=client_opt_out', async () => {
    // The BYO-extraction opt-out must stay on the synchronous path: the
    // caller PUTs its parsed fields right after upload, and a deferred flip
    // would overwrite them.
    const captured: { row?: Record<string, unknown> } = {}
    const supabase = makeSupabase(captured)

    const bytes = await makePdfBuffer(1)
    const file = new File([bytes as BlobPart], '1-page.pdf', { type: 'application/pdf' })
    const form = new FormData()
    form.set('file', file)
    form.set('skip_extraction', 'true')
    const req = makeMultipartRequest(form)

    const res = await uploadRoute.handler(req, buildCtx(supabase))
    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(extractInvoiceFields).not.toHaveBeenCalled()
    expect(body.data.status).toBe('received')
    expect(body.data.extraction_skipped).toBe(true)
    expect(body.data.skip_reason).toBe('client_opt_out')
    expect(captured.row?.status).toBe('received')
  })
})
