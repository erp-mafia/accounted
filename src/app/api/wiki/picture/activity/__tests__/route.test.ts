/**
 * GET /api/wiki/picture/activity: what the company's connections did today.
 * Runs through the real withRouteContext wrapper with auth, the company and
 * the loader mocked.
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

const loadAgentActivityMock = vi.fn()
vi.mock('@/lib/agent-context/agent-picture', () => ({
  loadAgentActivity: (...args: unknown[]) => loadAgentActivityMock(...args),
}))

import { GET } from '../route'

const COMPANY = 'company-1'
const ACTIVITY = {
  now: '2026-03-02T09:00:00.000Z',
  day: '2026-03-02',
  actors: { 'key-1': { calls_today: 14, last_call_at: '2026-03-02T08:59:30.000Z' } },
  capped: false,
}

const call = () => GET(createMockRequest('/api/wiki/picture/activity'), { params: Promise.resolve({}) })

describe('GET /api/wiki/picture/activity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    getActiveCompanyIdMock.mockResolvedValue(COMPANY)
    loadAgentActivityMock.mockResolvedValue(ACTIVITY)
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await parseJsonResponse(await call())).status).toBe(401)
    expect(loadAgentActivityMock).not.toHaveBeenCalled()
  })

  it('returns 400 when there is no active company', async () => {
    getActiveCompanyIdMock.mockResolvedValue(null)
    expect((await parseJsonResponse(await call())).status).toBe(400)
    expect(loadAgentActivityMock).not.toHaveBeenCalled()
  })

  it('answers 404 for a company the picture is not switched on for, and reads nothing', async () => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', '')
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(loadAgentActivityMock).not.toHaveBeenCalled()
  })

  it('returns the activity of the active company', async () => {
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await call())
    expect(status).toBe(200)
    expect(body.data).toEqual(ACTIVITY)
    expect(loadAgentActivityMock).toHaveBeenCalledWith(supabase, COMPANY)
  })

  it('answers a log that cannot be read with the canonical 500 envelope', async () => {
    loadAgentActivityMock.mockRejectedValue(new Error('tool call log read failed: boom'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
    expect(status).toBe(500)
    expect(typeof body.error.code).toBe('string')
  })
})
