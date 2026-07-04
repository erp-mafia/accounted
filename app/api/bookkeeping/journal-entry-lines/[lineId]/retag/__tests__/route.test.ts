/**
 * Tests for POST /api/bookkeeping/journal-entry-lines/[lineId]/retag
 * (dimensions plan PR6: Tier-2 retro-tagging via the audited RPC).
 *
 * Covers: 401, validation 400 (bad bag / short reason), the rule-violation
 * 409 passthrough (Swedish RPC errors surface verbatim), unexpected RPC
 * failure 500, the happy path and the untag ({}) path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const rpcMock = vi.fn()
;(supabase as { rpc?: unknown }).rpc = rpcMock

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../route'

const params = () => createMockRouteParams({ lineId: 'line-1' })

function makeRetagRequest(body: unknown) {
  return createMockRequest('/api/bookkeeping/journal-entry-lines/line-1/retag', {
    method: 'POST',
    body,
  })
}

describe('POST /api/bookkeeping/journal-entry-lines/[lineId]/retag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(
      makeRetagRequest({ dimensions: { '6': 'P001' }, reason: 'Rätt projekt' }),
      params(),
    )
    expect(response.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing reason', { dimensions: { '6': 'P001' } }],
    ['short reason', { dimensions: { '6': 'P001' }, reason: 'ab' }],
    ['SIE-breaking code', { dimensions: { '6': 'P{1}' }, reason: 'Testar' }],
    ['non-numeric dim key', { dimensions: { projekt: 'P001' }, reason: 'Testar' }],
  ])('rejects invalid body (%s) with 400', async (_label, body) => {
    const response = await POST(makeRetagRequest(body), params())
    expect(response.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('passes rule violations through as 409 with the Swedish message', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Perioden är stängd: använd rättelseverifikat (storno) för att ändra dimensioner.' },
    })

    const response = await POST(
      makeRetagRequest({ dimensions: { '6': 'P001' }, reason: 'Rätt projekt' }),
      params(),
    )
    const { body } = await parseJsonResponse<{ error: string }>(response)

    expect(response.status).toBe(409)
    expect(body.error).toContain('stängd')
  })

  it('returns 500 on unexpected RPC failure', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '57P01', message: 'connection refused' } })

    const response = await POST(
      makeRetagRequest({ dimensions: { '6': 'P001' }, reason: 'Rätt projekt' }),
      params(),
    )
    expect(response.status).toBe(500)
  })

  it('retags via the RPC with the caller as explicit actor (happy path)', async () => {
    rpcMock.mockResolvedValue({
      data: { changed: true, log_id: 'log-1', old_dimensions: {}, new_dimensions: { '6': 'P001' } },
      error: null,
    })

    const response = await POST(
      makeRetagRequest({ dimensions: { '6': 'P001' }, reason: 'Rätt projekt' }),
      params(),
    )
    const { body } = await parseJsonResponse<{ data: { changed: boolean; log_id: string } }>(response)

    expect(response.status).toBe(200)
    expect(body.data.changed).toBe(true)
    expect(rpcMock).toHaveBeenCalledWith('retag_line_dimensions', {
      p_company_id: 'company-1',
      p_line_id: 'line-1',
      p_dimensions: { '6': 'P001' },
      p_reason: 'Rätt projekt',
      p_user_id: 'user-1',
    })
  })

  it('accepts an empty bag (untag)', async () => {
    rpcMock.mockResolvedValue({ data: { changed: true, log_id: 'log-2' }, error: null })

    const response = await POST(makeRetagRequest({ dimensions: {}, reason: 'Feltaggad rad' }), params())

    expect(response.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith(
      'retag_line_dimensions',
      expect.objectContaining({ p_dimensions: {} }),
    )
  })
})
