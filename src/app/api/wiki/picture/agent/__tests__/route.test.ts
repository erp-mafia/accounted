/**
 * GET /api/wiki/picture/agent: what one card of the agent picture did for
 * the company. Runs through the real withRouteContext wrapper with auth, the
 * company and the loader mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

const getActiveCompanyIdMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...args: unknown[]) => getActiveCompanyIdMock(...args),
}))

const loadAgentCardWorkMock = vi.fn()
vi.mock('@/lib/agent-context/agent-work', () => ({
  loadAgentCardWork: (...args: unknown[]) => loadAgentCardWorkMock(...args),
}))

import { GET } from '../route'

const COMPANY = 'company-1'
const WORK = {
  card: 'claude',
  questions: { waiting: [{ question_id: 'q1', question: 'Vad avser betalningen?', asked_at: '2026-03-01T08:00:00.000Z' }], waiting_total: 1, answered: 2 },
  proposals: { waiting: [], waiting_total: 0, approved: 4, rejected: 1 },
}

const call = (query = '?card=claude') => GET(createMockRequest(`/api/wiki/picture/agent${query}`), { params: Promise.resolve({}) })

describe('GET /api/wiki/picture/agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    getActiveCompanyIdMock.mockResolvedValue(COMPANY)
    loadAgentCardWorkMock.mockResolvedValue(WORK)
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await parseJsonResponse(await call())).status).toBe(401)
    expect(loadAgentCardWorkMock).not.toHaveBeenCalled()
  })

  it('returns 400 when there is no active company', async () => {
    getActiveCompanyIdMock.mockResolvedValue(null)
    expect((await parseJsonResponse(await call())).status).toBe(400)
    expect(loadAgentCardWorkMock).not.toHaveBeenCalled()
  })

  it('returns 400 for a card that is missing or is not a card id, and reads nothing', async () => {
    for (const query of ['', '?card=', '?card=Claude', '?card=key:', '?card=key:not/an/id', '?card=other:0d6f6f0e-0000-4000-8000-000000000001', `?card=${'a'.repeat(41)}`, '?card=claude%20or%201']) {
      const { status, body } = await parseJsonResponse<{ type: string }>(await call(query))
      expect(status, query).toBe(400)
      expect(body.type).toBe('validation_error')
    }
    expect(loadAgentCardWorkMock).not.toHaveBeenCalled()
  })

  it('answers 404 for a company the picture is not switched on for, and reads nothing', async () => {
    for (const value of ['', 'another-company']) {
      vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', value)
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
      expect(status).toBe(404)
      expect(body.error.code).toBe('NOT_FOUND')
    }
    expect(loadAgentCardWorkMock).not.toHaveBeenCalled()
  })

  it('answers 404 for a card the person cannot list', async () => {
    loadAgentCardWorkMock.mockResolvedValue(null)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call('?card=chatgpt'))
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns what the card did, read with the caller\'s own client for the active company and the signed-in person', async () => {
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await call())
    expect(status).toBe(200)
    expect(body.data).toEqual(WORK)
    expect(loadAgentCardWorkMock).toHaveBeenCalledWith(supabase, COMPANY, 'user-1', 'claude')
  })

  it('takes the id of a named connection\'s card and of a service account\'s card', async () => {
    for (const card of ['key:0d6f6f0e-0000-4000-8000-000000000001', 'account:0d6f6f0e-0000-4000-8000-000000000002', 'mcp', 'local']) {
      expect((await parseJsonResponse(await call(`?card=${encodeURIComponent(card)}`))).status, card).toBe(200)
      expect(loadAgentCardWorkMock).toHaveBeenLastCalledWith(supabase, COMPANY, 'user-1', card)
    }
  })

  it('answers a loader that throws with the canonical 500 envelope', async () => {
    loadAgentCardWorkMock.mockRejectedValue(new Error('boom'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
    expect(status).toBe(500)
    expect(typeof body.error.code).toBe('string')
  })
})
