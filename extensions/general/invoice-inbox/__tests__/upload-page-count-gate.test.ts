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

import { extractInvoiceFields, emptyResult } from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find(
    (r) => r.method === method && r.path === path,
  )!
}

const uploadRoute = findRoute('POST', '/upload')

// Build the supabase mock the upload handler needs:
//   .from('invoice_inbox_items').insert(row).select('*').single() → { data: row, error: null }
//   .from('suppliers').select().eq().eq()... .maybeSingle() → { data: null }
function makeSupabase(captured: { row?: Record<string, unknown> }) {
  const supplierChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
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

describe('POST /upload: page-count gate (issue #553)', () => {
  it('skips extraction and marks the row as skipped when PDF has more than 3 pages', async () => {
    const captured: { row?: Record<string, unknown> } = {}
    const supabase = makeSupabase(captured)

    const req = await makeUploadRequest(6)
    const res = await uploadRoute.handler(req, buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(extractInvoiceFields).not.toHaveBeenCalled()
    expect(captured.row?.extraction_skipped).toBe(true)
    expect(body.data.extraction_skipped).toBe(true)
    expect(body.data.skip_reason).toBe('too_many_pages')
    expect(body.data.page_count).toBe(6)
  })

  it('runs extraction normally for PDFs at or below the page-count limit', async () => {
    const captured: { row?: Record<string, unknown> } = {}
    const supabase = makeSupabase(captured)
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({
      data: emptyResult(),
      rawText: 'ok',
    })

    const req = await makeUploadRequest(2)
    const res = await uploadRoute.handler(req, buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(extractInvoiceFields).toHaveBeenCalledOnce()
    expect(captured.row?.extraction_skipped).toBe(false)
    expect(body.data.extraction_skipped).toBe(false)
    expect(body.data.skip_reason).toBeNull()
    expect(body.data.page_count).toBe(2)
  })

  it('honors client-side skip_extraction=true with skip_reason=client_opt_out', async () => {
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
    expect(body.data.extraction_skipped).toBe(true)
    expect(body.data.skip_reason).toBe('client_opt_out')
  })
})
