import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

let unauthorized = false
vi.mock('@/lib/api/with-route-context', () => ({
  withRouteContext: (_op: string, handler: (req: unknown, ctx: unknown, extra: unknown) => unknown) => {
    return async (req: unknown, extra: unknown) => {
      if (unauthorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      }
      return handler(req, { supabase, companyId: 'company-1', user: { id: 'user-1' } }, extra)
    }
  },
}))

const aiStatusMock = vi.fn()
vi.mock('@/lib/ai', () => ({
  getAiStatus: () => aiStatusMock(),
}))

import { GET, deriveExtractionStatus } from '../route'

const params = { params: Promise.resolve({ id: 'doc-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  unauthorized = false
  aiStatusMock.mockReturnValue({ configured: true })
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
})
