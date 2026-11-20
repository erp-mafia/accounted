import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
// The service-role client the abandoned stamp is written with.
const service = createQueuedMockSupabase()
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

let unauthorized = false
vi.mock('@/lib/api/with-route-context', () => ({
  withRouteContext: (_op: string, handler: (req: unknown, ctx: unknown, extra: unknown) => unknown) => {
    return async (req: unknown, extra: unknown) => {
      if (unauthorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      }
      return handler(req, { supabase, companyId: 'company-1', user: { id: 'user-1' }, log }, extra)
    }
  },
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => service.supabase }))
const registryGet = vi.fn()
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: (id: string) => registryGet(id) } }))

const aiStatusMock = vi.fn()
vi.mock('@/lib/ai', () => ({
  getAiStatus: () => aiStatusMock(),
}))

import { ABANDONED_STAMP, GET, deriveExtractionStatus } from '../route'

const params = { params: Promise.resolve({ id: 'doc-1' }) }
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  service.reset()
  unauthorized = false
  aiStatusMock.mockReturnValue({ configured: true })
  registryGet.mockResolvedValue({ id: 'document-extraction' })
})

describe('deriveExtractionStatus', () => {
  const base = { extracted_at: '2026-08-20T10:00:00Z', extracted_data: null, extraction_model: null }

  it('is running while unstamped on a configured deployment', () => {
    expect(deriveExtractionStatus({ ...base, extracted_at: null }, true)).toBe('running')
  })

  // The self-host "no key yet" case: answer on the first poll, no 30 s hang.
  it('is disabled while unstamped on an unconfigured deployment', () => {
    expect(deriveExtractionStatus({ ...base, extracted_at: null }, false)).toBe('disabled')
  })

  it('is succeeded when data landed', () => {
    expect(deriveExtractionStatus({ ...base, extracted_data: { a: 1 } }, true)).toBe('succeeded')
  })

  it('maps the quiet skips (paywall, unconfigured, sandbox, opt-out, system) to disabled', () => {
    for (const m of [
      'skipped:no_ai_entitlement',
      'skipped:ai_unconfigured',
      'skipped:sandbox',
      'skipped:client_opt_out',
      'skipped:system_generated',
    ]) {
      expect(deriveExtractionStatus({ ...base, extraction_model: m }, true)).toBe('disabled')
    }
  })

  it('maps every other skip to unsupported and failures to failed', () => {
    expect(deriveExtractionStatus({ ...base, extraction_model: 'skipped:unsupported_mime' }, true)).toBe('unsupported')
    expect(deriveExtractionStatus({ ...base, extraction_model: 'skipped:ai_no_vision' }, true)).toBe('unsupported')
    expect(deriveExtractionStatus({ ...base, extraction_model: 'failed:no_raw_text' }, true)).toBe('failed')
    expect(deriveExtractionStatus({ ...base, extraction_model: null }, true)).toBe('failed')
  })
})

describe('GET /api/documents/:id/extraction-status', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthorized = true
    const res = await GET(createMockRequest('/api/documents/doc-1/extraction-status'), params)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 404 for an unknown document', async () => {
    enqueue({ data: null })
    const res = await GET(createMockRequest('/api/documents/doc-1/extraction-status'), params)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns the derived status', async () => {
    enqueue({ data: { id: 'doc-1', extracted_at: '2026-08-20T10:00:00Z', extracted_data: null, extraction_model: 'skipped:no_ai_entitlement' } })
    const res = await GET(createMockRequest('/api/documents/doc-1/extraction-status'), params)
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(res)
    expect(status).toBe(200)
    expect(body.data.status).toBe('disabled')
  })

  it('answers disabled immediately on an unconfigured deployment', async () => {
    aiStatusMock.mockReturnValue({ configured: false })
    enqueue({ data: { id: 'doc-1', extracted_at: null, extracted_data: null, extraction_model: null } })
    const res = await GET(createMockRequest('/api/documents/doc-1/extraction-status'), params)
    const { body } = await parseJsonResponse<{ data: { status: string } }>(res)
    expect(body.data.status).toBe('disabled')
  })

  type FactsBody = { data: { status: string; facts: { vat_amount: number | null; vat_rate: number | null } | null } }

  it("returns the document's facts once it is read, so a review can book its moms", async () => {
    enqueue({
      data: {
        id: 'doc-1',
        extracted_at: '2026-09-26T19:00:00Z',
        extracted_data: { totals: { vatAmount: 200, total: 1000 }, vatBreakdown: [{ rate: 25, base: 800, amount: 200 }] },
        extraction_model: 'claude',
      },
    })
    const res = await GET(createMockRequest('/api/documents/doc-1/extraction-status'), params)
    const { status, body } = await parseJsonResponse<FactsBody>(res)
    expect(status).toBe(200)
    expect(body.data.status).toBe('succeeded')
    expect(body.data.facts?.vat_amount).toBe(200)
    expect(body.data.facts?.vat_rate).toBe(25)
  })

  it('returns no facts while the extraction is still running', async () => {
    enqueue({ data: { id: 'doc-1', created_at: minutesAgo(1), extracted_at: null, extracted_data: null, extraction_model: null } })
    const res = await GET(createMockRequest('/api/documents/doc-1/extraction-status'), params)
    const { body } = await parseJsonResponse<FactsBody>(res)
    expect(body.data.status).toBe('running')
    expect(body.data.facts).toBeNull()
    expect(service.calls).toEqual([])
  })
})

/**
 * The reading runs after the upload answered. When the function reading it
 * is frozen or killed, nothing ever stamps the document, and this route
 * answered "running" on every later visit.
 */
describe('GET /api/documents/:id/extraction-status, a reading that never finished', () => {
  type Body = { data: { status: string; extraction_model: string | null; extracted_at: string | null } }
  const unstamped = (created_at: string) => ({ id: 'doc-1', created_at, extracted_at: null, extracted_data: null, extraction_model: null })
  const get = async () => parseJsonResponse<Body>(await GET(createMockRequest('/api/documents/doc-1/extraction-status'), params))

  it('answers failed for a reading still open ten minutes after the upload, stamps it and reports it once', async () => {
    enqueue({ data: unstamped(minutesAgo(11)) })
    service.enqueue({ data: [{ id: 'doc-1' }] })
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.data.status).toBe('failed')
    expect(body.data.extraction_model).toBe(ABANDONED_STAMP)
    expect(body.data.extracted_at).not.toBeNull()
    // Written only onto a row still unstamped, in this company.
    expect(service.findCall('document_attachments', 'update')).toEqual([{ extracted_at: expect.any(String), extraction_model: 'failed:abandoned' }])
    expect(service.findCalls('document_attachments', 'eq')).toEqual([['id', 'doc-1'], ['company_id', 'company-1']])
    expect(service.findCall('document_attachments', 'is')).toEqual(['extracted_at', null])
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('interrupted'), expect.objectContaining({ doc: 'doc-1', companyId: 'company-1' }))
  })

  it('answers from the row as it is now when the stamp matched nothing: the reading landed between the read and the write', async () => {
    enqueue({ data: unstamped(minutesAgo(11)) })
    service.enqueue({ data: [] })
    // The row, read again: the real reading is there.
    enqueue({ data: { id: 'doc-1', extracted_at: minutesAgo(0), extracted_data: { totals: { vatAmount: 200, total: 1000 }, vatBreakdown: [{ rate: 25, base: 800, amount: 200 }] }, extraction_model: 'claude' } })
    const res = await GET(createMockRequest('/api/documents/doc-1/extraction-status'), params)
    const { body } = await parseJsonResponse<{ data: { status: string; extraction_model: string | null; facts: { vat_amount: number | null } | null } }>(res)
    // "failed" is final for the screen that polls: it would never have shown the reading that did arrive.
    expect(body.data.status).toBe('succeeded')
    expect(body.data.extraction_model).toBe('claude')
    expect(body.data.facts?.vat_amount).toBe(200)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('does not report again when another poll stamped it first', async () => {
    enqueue({ data: unstamped(minutesAgo(11)) })
    service.enqueue({ data: [] })
    enqueue({ data: { id: 'doc-1', extracted_at: minutesAgo(0), extracted_data: null, extraction_model: ABANDONED_STAMP } })
    const { body } = await get()
    expect(body.data.status).toBe('failed')
    expect(body.data.extraction_model).toBe(ABANDONED_STAMP)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('still answers failed when the stamp is refused (a document on a locked period), with a warning', async () => {
    enqueue({ data: unstamped(minutesAgo(11)) })
    service.enqueue({ error: { message: 'locked/closed fiscal period' } })
    expect((await get()).body.data.status).toBe('failed')
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('leaves a reading alone while it can still be running', async () => {
    enqueue({ data: unstamped(minutesAgo(9)) })
    expect((await get()).body.data.status).toBe('running')
    expect(service.calls).toEqual([])
    expect(log.error).not.toHaveBeenCalled()
  })

  it('settles an old row that never got a stamp without an alert nobody can act on', async () => {
    enqueue({ data: unstamped(minutesAgo(3 * 24 * 60)) })
    service.enqueue({ data: [{ id: 'doc-1' }] })
    expect((await get()).body.data.status).toBe('failed')
    expect(log.error).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('answers disabled, and stamps nothing, where no extension reads uploads at all', async () => {
    registryGet.mockResolvedValue(undefined)
    enqueue({ data: unstamped(minutesAgo(11)) })
    expect((await get()).body.data.status).toBe('disabled')
    expect(registryGet).toHaveBeenCalledWith('document-extraction')
    expect(service.calls).toEqual([])
    expect(log.error).not.toHaveBeenCalled()
  })

  it('never touches a document that has its stamp, however old', async () => {
    enqueue({ data: { ...unstamped(minutesAgo(600)), extracted_at: minutesAgo(599), extraction_model: 'failed:no_raw_text' } })
    expect((await get()).body.data.status).toBe('failed')
    expect(service.calls).toEqual([])
  })
})
