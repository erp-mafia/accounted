/**
 * GET /api/wiki/context: the wiki's context view. Runs through the real
 * withRouteContext wrapper with auth, the company and the loader mocked.
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

const loadAgentContextMock = vi.fn()
vi.mock('@/lib/agent-context/wiki-load', () => ({
  loadAgentContext: (...args: unknown[]) => loadAgentContextMock(...args),
}))

import { GET } from '../route'

const WINDOW = {
  scope: { company: { company_id: 'company-1', name: 'Exempelbolaget AB', org_number: null }, group: null },
  total_chars: 120,
  memory_budget: { used: 10, budget: 60000, truncated: false },
  sections: [],
}

describe('GET /api/wiki/context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    getActiveCompanyIdMock.mockResolvedValue('company-1')
    loadAgentContextMock.mockResolvedValue({ status: 'ok', window: WINDOW, text: '{}', scopes: 'default_connector' })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/wiki/context'), { params: Promise.resolve({}) })
    expect((await parseJsonResponse(res)).status).toBe(401)
    expect(loadAgentContextMock).not.toHaveBeenCalled()
  })

  it('returns 400 when there is no active company', async () => {
    getActiveCompanyIdMock.mockResolvedValue(null)
    const res = await GET(createMockRequest('/api/wiki/context'), { params: Promise.resolve({}) })
    expect((await parseJsonResponse(res)).status).toBe(400)
    expect(loadAgentContextMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the agent tools are not installed', async () => {
    loadAgentContextMock.mockResolvedValue({ status: 'unavailable' })
    const res = await GET(createMockRequest('/api/wiki/context'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(404)
    expect(body.error.code).toBe('AGENT_CONTEXT_UNAVAILABLE')
  })

  it('returns the window and the raw text for the active company and user', async () => {
    const res = await GET(createMockRequest('/api/wiki/context'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { window: unknown; text: string; scopes: string } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ window: WINDOW, text: '{}', scopes: 'default_connector' })
    expect(loadAgentContextMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1')
  })

  it('answers a failed briefing with the canonical 500 envelope', async () => {
    loadAgentContextMock.mockRejectedValue(new Error('boom'))
    const res = await GET(createMockRequest('/api/wiki/context'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(500)
    expect(typeof body.error.code).toBe('string')
  })
})
