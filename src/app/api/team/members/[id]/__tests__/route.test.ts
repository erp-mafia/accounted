import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

// PATCH/DELETE /api/team/members/[id] (WL-08 gap fix, the last frozen team
// surface): byrå-only role changes and removals with last-owner protection.
// Company-side effects are the DB triggers' job (AFTER UPDATE re-sync,
// BEFORE DELETE source='team' cleanup) and are pg-tested, not mocked here.

const { supabase: serviceSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

import { PATCH, DELETE } from '../route'

const mockUser = { id: 'user-1', email: 'chef@byra.se' }
const routeParams = createMockRouteParams({ id: 'tm-target' })

const patchReq = (role: string) =>
  createMockRequest('/api/team/members/tm-target', { method: 'PATCH', body: { role } })
const deleteReq = () =>
  createMockRequest('/api/team/members/tm-target', { method: 'DELETE' })

const targetRow = (overrides: Partial<{ role: string; kind: string; user_id: string }> = {}) => ({
  id: 'tm-target',
  team_id: 'team-b',
  user_id: overrides.user_id ?? 'user-2',
  role: overrides.role ?? 'member',
  teams: { kind: overrides.kind ?? 'byra' },
})

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: serviceSupabase, error: null })
})

describe('PATCH /api/team/members/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: serviceSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await PATCH(patchReq('admin'), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 for an invalid role', async () => {
    const res = await PATCH(patchReq('viewer'), routeParams)
    expect(res.status).toBe(400)
  })

  it('returns 404 when the membership row does not exist', async () => {
    enqueue({ data: null })
    const { status } = await parseJsonResponse(await PATCH(patchReq('admin'), routeParams))
    expect(status).toBe(404)
  })

  it('returns 403 with the legacy message for a personal-team membership', async () => {
    enqueue({ data: targetRow({ kind: 'personal' }) })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await PATCH(patchReq('admin'), routeParams),
    )
    expect(status).toBe(403)
    expect(body.error).toBe('Team har bara en ägare och kan inte ändras.')
  })

  it('returns 403 when the caller is a plain team member', async () => {
    enqueue({ data: targetRow() })
    enqueue({ data: { role: 'member' } })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await PATCH(patchReq('admin'), routeParams),
    )
    expect(status).toBe(403)
    expect(body.error).toBe('Behörighet saknas.')
  })

  it('only an owner may grant the owner role', async () => {
    enqueue({ data: targetRow() })
    enqueue({ data: { role: 'admin' } })
    const { status } = await parseJsonResponse(await PATCH(patchReq('owner'), routeParams))
    expect(status).toBe(403)
    expect(findCalls('team_members', 'update')).toHaveLength(0)
  })

  it("only an owner may change an owner's role", async () => {
    enqueue({ data: targetRow({ role: 'owner' }) })
    enqueue({ data: { role: 'admin' } })
    const { status } = await parseJsonResponse(await PATCH(patchReq('member'), routeParams))
    expect(status).toBe(403)
    expect(findCalls('team_members', 'update')).toHaveLength(0)
  })

  it('returns 409 when demoting the last owner', async () => {
    enqueue({ data: targetRow({ role: 'owner' }) })
    enqueue({ data: { role: 'owner' } })
    // owner count
    enqueue({ data: null, count: 1 })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await PATCH(patchReq('admin'), routeParams),
    )
    expect(status).toBe(409)
    expect(body.error).toBe('Teamet måste ha minst en ägare.')
    expect(findCalls('team_members', 'update')).toHaveLength(0)
  })

  it('demotes a non-last owner when the caller is an owner', async () => {
    enqueue({ data: targetRow({ role: 'owner' }) })
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: null, count: 2 })
    // update
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{
      data: { id: string; role: string }
    }>(await PATCH(patchReq('admin'), routeParams))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ id: 'tm-target', role: 'admin' })
    const updates = findCalls('team_members', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0]![0]).toEqual({ role: 'admin' })
  })

  it('promotes a member to admin for a byrå admin caller', async () => {
    enqueue({ data: targetRow({ role: 'member' }) })
    enqueue({ data: { role: 'admin' } })
    // update
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{
      data: { id: string; user_id: string; team_id: string; role: string }
    }>(await PATCH(patchReq('admin'), routeParams))
    expect(status).toBe(200)
    expect(body.data).toEqual({
      id: 'tm-target',
      user_id: 'user-2',
      team_id: 'team-b',
      role: 'admin',
    })
    const updates = findCalls('team_members', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0]![0]).toEqual({ role: 'admin' })
  })

  it('is a no-op (no write) when the role is unchanged', async () => {
    enqueue({ data: targetRow({ role: 'admin' }) })
    enqueue({ data: { role: 'owner' } })
    const { status, body } = await parseJsonResponse<{ data: { role: string } }>(
      await PATCH(patchReq('admin'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data.role).toBe('admin')
    expect(findCalls('team_members', 'update')).toHaveLength(0)
  })
})

describe('DELETE /api/team/members/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: serviceSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await DELETE(deleteReq(), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the membership row does not exist', async () => {
    enqueue({ data: null })
    const { status } = await parseJsonResponse(await DELETE(deleteReq(), routeParams))
    expect(status).toBe(404)
  })

  it('returns 403 with the legacy message for a personal-team membership', async () => {
    enqueue({ data: targetRow({ kind: 'personal' }) })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await DELETE(deleteReq(), routeParams),
    )
    expect(status).toBe(403)
    expect(body.error).toBe('Team har bara en ägare och kan inte ändras.')
  })

  it('returns 403 when the caller is a plain team member', async () => {
    enqueue({ data: targetRow() })
    enqueue({ data: { role: 'member' } })
    const { status } = await parseJsonResponse(await DELETE(deleteReq(), routeParams))
    expect(status).toBe(403)
    expect(findCalls('team_members', 'delete')).toHaveLength(0)
  })

  it('only an owner may remove an owner', async () => {
    enqueue({ data: targetRow({ role: 'owner' }) })
    enqueue({ data: { role: 'admin' } })
    const { status } = await parseJsonResponse(await DELETE(deleteReq(), routeParams))
    expect(status).toBe(403)
    expect(findCalls('team_members', 'delete')).toHaveLength(0)
  })

  it('returns 409 when removing the last owner', async () => {
    enqueue({ data: targetRow({ role: 'owner', user_id: 'user-1' }) })
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: null, count: 1 })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await DELETE(deleteReq(), routeParams),
    )
    expect(status).toBe(409)
    expect(body.error).toBe('Teamet måste ha minst en ägare.')
    expect(findCalls('team_members', 'delete')).toHaveLength(0)
  })

  it('removes a member for a byrå admin; company cleanup is the trigger', async () => {
    enqueue({ data: targetRow({ role: 'member' }) })
    enqueue({ data: { role: 'admin' } })
    // delete
    enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{
      data: { id: string; removed: boolean }
    }>(await DELETE(deleteReq(), routeParams))
    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'tm-target', removed: true })
    expect(findCalls('team_members', 'delete')).toHaveLength(1)
    // The route never touches company_members: the BEFORE DELETE sync trigger
    // owns that cleanup (migration 20260331010000).
    expect(findCalls('company_members', 'delete')).toHaveLength(0)
  })
})
