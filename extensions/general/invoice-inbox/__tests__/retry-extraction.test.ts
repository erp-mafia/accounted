import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
} from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@/extensions/general/invoice-inbox/lib/extract-invoice-fields', () => ({
  extractInvoiceFields: vi.fn(),
}))

vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

// Paid AI OCR gate. Retry is an explicit "run AI now" action, so a company
// without CAPABILITY.ai is hard-blocked (403). Default to entitled here;
// capabilityBlockedResponse stays real so the 403 envelope is exercised.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { extractInvoiceFields } from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'
import { hasCapability } from '@/lib/entitlements/has-capability'

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find(
    (r) => r.method === method && r.path === path,
  )!
}

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

function makeReq() {
  return createMockRequest('/items/item-1/retry-extraction', {
    method: 'POST',
    searchParams: { _id: 'item-1' },
  })
}

const EXTRACTION_SUCCESS = {
  data: {
    supplier: { name: 'Acme AB', orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
    invoice: { invoiceNumber: 'F-1', invoiceDate: '2026-05-01', dueDate: null, paymentReference: null, currency: 'SEK' },
    lineItems: [],
    totals: { subtotal: 100, vatAmount: 25, total: 125 },
    vatBreakdown: [],
    confidence: 1,
  },
  rawText: 'mock',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkInboxUploadRateLimit).mockResolvedValue({ ok: true })
  vi.mocked(hasCapability).mockResolvedValue(true)
})

describe('POST /items/:id/retry-extraction', () => {
  it('returns 401 when no context', async () => {
    const res = await retryRoute.handler(makeReq(), undefined)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 429 when the per-company rate limit is exceeded', async () => {
    vi.mocked(checkInboxUploadRateLimit).mockResolvedValueOnce({
      ok: false,
      scope: 'minute',
      retryAfterSec: 30,
    })
    const { supabase } = createQueuedMockSupabase()
    const res = await retryRoute.handler(makeReq(), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(429)
    expect(body.error).toMatch(/för många/i)
    expect(res.headers.get('Retry-After')).toBe('30')
  })

  it('returns 404 when the inbox item is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // item lookup
    const res = await retryRoute.handler(makeReq(), buildCtx(supabase))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 409 when already booked as supplier invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'item-1', document_id: 'doc-1', correlation_id: null, created_supplier_invoice_id: 'si-1' },
      error: null,
    })
    const res = await retryRoute.handler(makeReq(), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toMatch(/redan bokfört/i)
  })

  it('hard-blocks with 403 capability_blocked when the company lacks the ai capability', async () => {
    vi.mocked(hasCapability).mockResolvedValueOnce(false)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'item-1', document_id: 'doc-1', correlation_id: null, created_supplier_invoice_id: null },
      error: null,
    }) // item lookup: the ai gate fires immediately after
    const res = await retryRoute.handler(makeReq(), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ capability_blocked: boolean; capability: string }>(res)
    expect(status).toBe(403)
    expect(body.capability_blocked).toBe(true)
    expect(body.capability).toBe('ai')
    expect(extractInvoiceFields).not.toHaveBeenCalled()
  })

  it('returns 400 when the item has no attached document', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'item-1', document_id: null, correlation_id: null, created_supplier_invoice_id: null },
      error: null,
    })
    const res = await retryRoute.handler(makeReq(), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(400)
    expect(body.error).toMatch(/Ingen bilaga/i)
  })

  it('returns 200 with re-extracted data on the happy path', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'item-1', document_id: 'doc-1', correlation_id: null, created_supplier_invoice_id: null },
      error: null,
    })
    enqueue({ data: { is_sandbox: false }, error: null }) // sandbox check
    enqueue({
      data: { storage_path: 'path/to.pdf', mime_type: 'application/pdf', file_name: 'invoice.pdf' },
      error: null,
    })
    enqueue({ data: null, error: null }) // inbox update on success

    supabase.storage.from = vi.fn().mockReturnValue({
      download: vi.fn().mockResolvedValue({
        data: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }),
        error: null,
      }),
    })

    vi.mocked(extractInvoiceFields).mockResolvedValueOnce(EXTRACTION_SUCCESS as never)

    const res = await retryRoute.handler(makeReq(), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: { extracted_data: { totals: { total: number } } } }>(res)
    expect(status).toBe(200)
    expect(body.data.extracted_data.totals.total).toBe(125)
  })

  it('marks the item as error and returns 500 when extraction throws', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'item-1', document_id: 'doc-1', correlation_id: null, created_supplier_invoice_id: null },
      error: null,
    })
    enqueue({ data: { is_sandbox: false }, error: null }) // sandbox check
    enqueue({
      data: { storage_path: 'path/to.pdf', mime_type: 'application/pdf', file_name: 'invoice.pdf' },
      error: null,
    })
    enqueue({ data: null, error: null }) // error-state update

    supabase.storage.from = vi.fn().mockReturnValue({
      download: vi.fn().mockResolvedValue({
        data: new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
        error: null,
      }),
    })

    vi.mocked(extractInvoiceFields).mockRejectedValueOnce(new Error('pdfjs blew up'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await retryRoute.handler(makeReq(), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(500)
    expect(body.error).toBe('pdfjs blew up')
    spy.mockRestore()
  })
})
