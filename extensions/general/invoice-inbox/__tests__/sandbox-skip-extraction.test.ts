import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
} from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

// Mock the Bedrock call. The whole point of this file is to assert it is
// never invoked on sandbox companies.
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
// to entitled (true) so the sandbox/page-count reasons are exercised; the
// no-AI tests below override to false. capabilityBlockedResponse stays real so
// the retry 403 envelope is genuine.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { extractInvoiceFields } from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'
import { hasCapability } from '@/lib/entitlements/has-capability'

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find(
    (r) => r.method === method && r.path === path,
  )!
}

const uploadRoute = findRoute('POST', '/upload')
const attachRoute = findRoute('POST', '/items/:id/attach-document')
const retryRoute = findRoute('POST', '/items/:id/retry-extraction')

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

function makeMultipartRequest(form: FormData, path: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    body: form,
  })
}

// Supabase mock routed by table name. The /upload handler hits
// company_settings (sandbox check), invoice_inbox_items (insert), and
// suppliers (match) in that order via separate .from() chains.
function makeUploadSupabase(opts: {
  isSandbox: boolean
  captured: { row?: Record<string, unknown> }
}) {
  const settingsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { is_sandbox: opts.isSandbox }, error: null }),
  }
  const supplierChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
  }
  const inboxChain = {
    insert: vi.fn((row: Record<string, unknown>) => {
      opts.captured.row = row
      return {
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'inbox-1', status: 'received', matched_supplier_id: null, ...row },
            error: null,
          }),
        }),
      }
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnThis(),
    }),
  }
  return {
    from: vi.fn((table: string) => {
      if (table === 'company_settings') return settingsChain
      if (table === 'invoice_inbox_items') return inboxChain
      return supplierChain
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hasCapability).mockResolvedValue(true)
})

describe('Sandbox companies skip Bedrock extraction', () => {
  describe('POST /upload', () => {
    it('skips extraction and reports skip_reason=sandbox', async () => {
      const captured: { row?: Record<string, unknown> } = {}
      const supabase = makeUploadSupabase({ isSandbox: true, captured })

      const bytes = await makePdfBuffer(1)
      const file = new File([bytes as BlobPart], 'receipt.pdf', { type: 'application/pdf' })
      const form = new FormData()
      form.set('file', file)

      const res = await uploadRoute.handler(makeMultipartRequest(form, '/upload'), buildCtx(supabase))
      const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

      expect(status).toBe(200)
      expect(extractInvoiceFields).not.toHaveBeenCalled()
      expect(body.data.extraction_skipped).toBe(true)
      expect(body.data.skip_reason).toBe('sandbox')
      expect(captured.row?.extraction_skipped).toBe(true)
    })

    it('runs extraction normally for non-sandbox companies', async () => {
      const captured: { row?: Record<string, unknown> } = {}
      const supabase = makeUploadSupabase({ isSandbox: false, captured })
      vi.mocked(extractInvoiceFields).mockResolvedValueOnce({
        data: {
          supplier: { name: null, orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
          invoice: { invoiceNumber: null, invoiceDate: null, dueDate: null, paymentReference: null, currency: 'SEK' },
          lineItems: [],
          totals: { subtotal: null, vatAmount: null, total: null },
          vatBreakdown: [],
          confidence: 0,
        },
        rawText: 'ok',
      })

      const bytes = await makePdfBuffer(1)
      const file = new File([bytes as BlobPart], 'receipt.pdf', { type: 'application/pdf' })
      const form = new FormData()
      form.set('file', file)

      const res = await uploadRoute.handler(makeMultipartRequest(form, '/upload'), buildCtx(supabase))
      const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

      expect(status).toBe(200)
      expect(extractInvoiceFields).toHaveBeenCalledOnce()
      expect(body.data.extraction_skipped).toBe(false)
      expect(body.data.skip_reason).toBeNull()
    })
  })

  describe('POST /items/:id/attach-document', () => {
    it('skips extraction when company is a sandbox', async () => {
      // Lookup order: item exists → upload doc → sandbox check → update row.
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({
        data: {
          id: 'item-1',
          document_id: null,
          status: 'received',
          correlation_id: null,
          created_supplier_invoice_id: null,
        },
        error: null,
      })
      // sandbox check inside the try block
      enqueue({ data: { is_sandbox: true }, error: null })
      // update row
      enqueue({ data: null, error: null })

      // uploadDocument is mocked at the module level; no need to enqueue.

      const bytes = await makePdfBuffer(1)
      const file = new File([bytes as BlobPart], 'attach.pdf', { type: 'application/pdf' })
      const form = new FormData()
      form.set('file', file)

      const req = new Request('http://localhost:3000/items/item-1/attach-document?_id=item-1', {
        method: 'POST',
        body: form,
      })

      const res = await attachRoute.handler(req, buildCtx(supabase))
      const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

      expect(status).toBe(200)
      expect(extractInvoiceFields).not.toHaveBeenCalled()
      expect(body.data.extraction_skipped).toBe(true)
      expect(body.data.skip_reason).toBe('sandbox')
    })
  })

  describe('POST /items/:id/retry-extraction', () => {
    it('returns 409 with a Swedish message when the company is a sandbox', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      // item lookup
      enqueue({
        data: { id: 'item-1', document_id: 'doc-1', correlation_id: null, created_supplier_invoice_id: null },
        error: null,
      })
      // sandbox check → true
      enqueue({ data: { is_sandbox: true }, error: null })

      const req = createMockRequest('/items/item-1/retry-extraction', {
        method: 'POST',
        searchParams: { _id: 'item-1' },
      })

      const res = await retryRoute.handler(req, buildCtx(supabase))
      const { status, body } = await parseJsonResponse<{ error: string }>(res)

      expect(status).toBe(409)
      expect(body.error).toMatch(/sandlådan/i)
      expect(extractInvoiceFields).not.toHaveBeenCalled()
    })
  })
})

// The paid-tier paywall: a free/manual-tier company (no `ai` capability) must
// never trigger Bedrock OCR. Upload + attach degrade gracefully (document is
// stored, extraction skipped with reason 'no_ai_entitlement'); retry is an
// explicit "run AI" action and hard-blocks with 403 capability_blocked.
describe('Free tier (no ai capability) does not run Bedrock extraction', () => {
  it('POST /upload: skips extraction with skip_reason=no_ai_entitlement (highest priority)', async () => {
    vi.mocked(hasCapability).mockResolvedValueOnce(false)
    const captured: { row?: Record<string, unknown> } = {}
    // Not a sandbox: proves the ai gate wins over a passing sandbox check.
    const supabase = makeUploadSupabase({ isSandbox: false, captured })

    const bytes = await makePdfBuffer(1)
    const file = new File([bytes as BlobPart], 'receipt.pdf', { type: 'application/pdf' })
    const form = new FormData()
    form.set('file', file)

    const res = await uploadRoute.handler(makeMultipartRequest(form, '/upload'), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(extractInvoiceFields).not.toHaveBeenCalled()
    expect(body.data.extraction_skipped).toBe(true)
    expect(body.data.skip_reason).toBe('no_ai_entitlement')
    expect(captured.row?.extraction_skipped).toBe(true)
  })

  it('POST /items/:id/attach-document: skips extraction when the company lacks ai', async () => {
    vi.mocked(hasCapability).mockResolvedValueOnce(false)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'item-1',
        document_id: null,
        status: 'received',
        correlation_id: null,
        created_supplier_invoice_id: null,
      },
      error: null,
    })
    // sandbox check → false (so the ai gate, not sandbox, is what skips)
    enqueue({ data: { is_sandbox: false }, error: null })
    // update row
    enqueue({ data: null, error: null })

    const bytes = await makePdfBuffer(1)
    const file = new File([bytes as BlobPart], 'attach.pdf', { type: 'application/pdf' })
    const form = new FormData()
    form.set('file', file)

    const req = new Request('http://localhost:3000/items/item-1/attach-document?_id=item-1', {
      method: 'POST',
      body: form,
    })

    const res = await attachRoute.handler(req, buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(extractInvoiceFields).not.toHaveBeenCalled()
    expect(body.data.extraction_skipped).toBe(true)
    expect(body.data.skip_reason).toBe('no_ai_entitlement')
  })

  it('POST /items/:id/retry-extraction: hard-blocks with 403 capability_blocked', async () => {
    vi.mocked(hasCapability).mockResolvedValueOnce(false)
    const { supabase, enqueue } = createQueuedMockSupabase()
    // item lookup: the ai gate fires immediately after, before the sandbox check
    enqueue({
      data: { id: 'item-1', document_id: 'doc-1', correlation_id: null, created_supplier_invoice_id: null },
      error: null,
    })

    const req = createMockRequest('/items/item-1/retry-extraction', {
      method: 'POST',
      searchParams: { _id: 'item-1' },
    })

    const res = await retryRoute.handler(req, buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ capability_blocked: boolean; capability: string }>(res)

    expect(status).toBe(403)
    expect(body.capability_blocked).toBe(true)
    expect(body.capability).toBe('ai')
    expect(extractInvoiceFields).not.toHaveBeenCalled()
  })
})
