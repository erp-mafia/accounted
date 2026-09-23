/**
 * Tests for POST /api/bookkeeping/journal-entries/[id]/correct-metadata
 * (metadata rättelse of a posted verifikat via the audited RPC).
 *
 * Covers: 401, validation 400 (empty body / blank description / bad date),
 * rule-violation 409 passthrough (Swedish RPC messages verbatim), tenant
 * guard 403, unexpected RPC failure 500, and the happy path.
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

const params = () => createMockRouteParams({ id: 'entry-1' })

function makeRequest(body: unknown) {
  return createMockRequest('/api/bookkeeping/journal-entries/entry-1/correct-metadata', {
    method: 'POST',
    body,
  })
}

describe('POST /api/bookkeeping/journal-entries/[id]/correct-metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(makeRequest({ description: 'Rättad text' }), params())
    expect(response.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it.each([
    ['empty body', {}],
    ['blank description', { description: '   ' }],
    ['bad date', { entry_date: 'inte-ett-datum' }],
  ])('rejects invalid body (%s) with 400', async (_label, body) => {
    const response = await POST(makeRequest(body), params())
    expect(response.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('passes rule violations through as 409 with the Swedish message', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Perioden är stängd eller låst — använd rättelseverifikat (storno).' },
    })

    const response = await POST(makeRequest({ description: 'Rättad text' }), params())
    const { body } = await parseJsonResponse<{ error: string }>(response)

    expect(response.status).toBe(409)
    expect(body.error).toContain('låst')
  })

  it('maps the tenant guard (42501) to 403', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'unauthorized: caller is not a member of company company-1' },
    })

    const response = await POST(makeRequest({ description: 'Rättad text' }), params())
    expect(response.status).toBe(403)
  })

  it('returns 500 on unexpected RPC failure', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '57P01', message: 'connection refused' } })

    const response = await POST(makeRequest({ description: 'Rättad text' }), params())
    expect(response.status).toBe(500)
  })

  it('corrects description and date via the RPC with the caller as actor (happy path)', async () => {
    rpcMock.mockResolvedValue({
      data: {
        changed: true,
        log_id: 'log-1',
        old_description: 'Gamal text',
        new_description: 'Rättad text',
        old_entry_date: '2026-07-01',
        new_entry_date: '2026-07-05',
      },
      error: null,
    })

    const response = await POST(
      makeRequest({ description: 'Rättad text', entry_date: '2026-07-05' }),
      params(),
    )
    const { body } = await parseJsonResponse<{ data: { changed: boolean; log_id: string } }>(response)

    expect(response.status).toBe(200)
    expect(body.data.changed).toBe(true)
    expect(rpcMock).toHaveBeenCalledWith('correct_entry_metadata', {
      p_company_id: 'company-1',
      p_entry_id: 'entry-1',
      p_description: 'Rättad text',
      p_entry_date: '2026-07-05',
      p_user_id: 'user-1',
    })
  })

  it('sends null for omitted fields (description-only edit)', async () => {
    rpcMock.mockResolvedValue({ data: { changed: true, log_id: 'log-2' }, error: null })

    const response = await POST(makeRequest({ description: 'Bara texten' }), params())

    expect(response.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith(
      'correct_entry_metadata',
      expect.objectContaining({ p_description: 'Bara texten', p_entry_date: null }),
    )
  })
})
