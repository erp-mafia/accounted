/**
 * GET /api/company/members: the roster, the pending invitations and, for the
 * byrå of a client company, the profile choice its invite form requires.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase: serviceSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

const getMultiUserStateMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/entitlements/multi-user', () => ({
  getMultiUserState: (...args: unknown[]) => getMultiUserStateMock(...args),
}))

const readClientProfileChoiceMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/company/client-profile', () => ({
  readClientProfileChoice: (...args: unknown[]) => readClientProfileChoiceMock(...args),
}))

import { GET } from '../route'

const routeParams = { params: Promise.resolve({}) }
const get = () => GET(createMockRequest('/api/company/members', { method: 'GET' }), routeParams)

function enqueueRoster(role: string) {
  enqueue({ data: [{ id: 'm-1', user_id: 'user-1', role, source: 'team', joined_at: '2026-10-01T00:00:00Z' }] })
  enqueue({ data: [{ id: 'user-1', email: 'byra@example.com' }] }) // profiles
  enqueue({ data: [] }) // pending invitations
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'byra@example.com' }, supabase: {}, error: null })
  getMultiUserStateMock.mockResolvedValue({ state: 'entitled', graceEndsAt: null })
  readClientProfileChoiceMock.mockResolvedValue(null)
})

describe('GET /api/company/members', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await get()).status).toBe(401)
  })

  it('returns the profile choice to the byrå of a client company', async () => {
    readClientProfileChoiceMock.mockResolvedValue({ current: null, preselected: 'limited-company-no-employees' })
    enqueueRoster('admin')
    const { status, body } = await parseJsonResponse<{ data: { canInvite: boolean; profileChoice: unknown } }>(await get())
    expect(status).toBe(200)
    expect(body.data.canInvite).toBe(true)
    expect(body.data.profileChoice).toEqual({ current: null, preselected: 'limited-company-no-employees' })
    expect(readClientProfileChoiceMock).toHaveBeenCalledWith(serviceSupabase, 'company-1', 'user-1')
  })

  it('returns no profile choice to a company that is not a byrå client', async () => {
    enqueueRoster('owner')
    const { status, body } = await parseJsonResponse<{ data: { profileChoice: unknown } }>(await get())
    expect(status).toBe(200)
    expect(body.data.profileChoice).toBeNull()
  })

  it('never asks for the choice when the caller cannot invite', async () => {
    enqueueRoster('member')
    const { body } = await parseJsonResponse<{ data: { canInvite: boolean; profileChoice: unknown } }>(await get())
    expect(body.data.canInvite).toBe(false)
    expect(body.data.profileChoice).toBeNull()
    expect(readClientProfileChoiceMock).not.toHaveBeenCalled()
  })
})
