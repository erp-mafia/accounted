/**
 * PATCH (role change) and DELETE (remove) /api/company/members/[id]: one
 * gate chain, owner or admin to remove and owner only to change a role, and
 * both refuse the caller's own row, the owner's row and a team-sourced row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase: serviceSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

import { PATCH, DELETE } from '../route'

const MEMBER_ID = '6f1c2b8e-0d4a-4c3e-9a51-2b7d8e9f0a11'
const routeParams = createMockRouteParams({ id: MEMBER_ID })

function patch(body: unknown, params: { params: Promise<{ id: string }> } = routeParams) {
  return PATCH(
    createMockRequest(`/api/company/members/${MEMBER_ID}`, { method: 'PATCH', body }),
    params,
  )
}

function del() {
  return DELETE(createMockRequest(`/api/company/members/${MEMBER_ID}`, { method: 'DELETE' }), routeParams)
}

const directMember = { id: MEMBER_ID, user_id: 'user-2', role: 'member', source: 'direct' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', email: 'owner@example.com' },
    supabase: {},
    error: null,
  })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('PATCH /api/company/members/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await patch({ role: 'viewer' })
    expect(res.status).toBe(401)
    expect(findCalls('company_members', 'update')).toHaveLength(0)
  })

  it('returns 400 for a role outside the grantable ones, owner included', async () => {
    for (const role of ['owner', 'superuser', '']) {
      const res = await patch({ role })
      expect(res.status).toBe(400)
    }
    const missing = await patch({})
    expect(missing.status).toBe(400)
    expect(findCalls('company_members', 'select')).toHaveLength(0)
    expect(findCalls('company_members', 'update')).toHaveLength(0)
  })

  it('returns 403 for a caller who is not the owner, admin included, before looking up the member', async () => {
    for (const callerRole of ['admin', 'member', 'viewer', 'invoicer']) {
      reset()
      enqueue({ data: { role: callerRole } }) // caller membership
      const { status, body } = await parseJsonResponse<{ error: string }>(await patch({ role: 'viewer' }))
      expect(status).toBe(403)
      expect(body.error).toBe('Behörighet saknas.')
      // Only the caller's own membership was read.
      expect(findCalls('company_members', 'select')).toHaveLength(1)
      expect(findCalls('company_members', 'update')).toHaveLength(0)
    }
  })

  it('returns 404 when the member is not in the active company', async () => {
    enqueue({ data: { role: 'owner' } }) // caller membership
    enqueue({ data: null }) // member lookup with source
    enqueue({ data: null }) // fallback lookup without source

    const { status } = await parseJsonResponse(await patch({ role: 'viewer' }))

    expect(status).toBe(404)
    expect(findCalls('company_members', 'eq')).toEqual(
      expect.arrayContaining([
        ['id', MEMBER_ID],
        ['company_id', 'company-1'],
      ]),
    )
    expect(findCalls('company_members', 'update')).toHaveLength(0)
  })

  it('answers 404 for a path id that is not a uuid, before any read', async () => {
    const { status } = await parseJsonResponse(
      await patch({ role: 'viewer' }, createMockRouteParams({ id: 'new' })),
    )
    expect(status).toBe(404)
    expect(findCalls('company_members', 'select')).toHaveLength(0)
  })

  it("refuses the caller's own role (400)", async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: { ...directMember, user_id: 'user-1', role: 'owner' } })

    const { status, body } = await parseJsonResponse<{ error: string }>(await patch({ role: 'member' }))

    expect(status).toBe(400)
    expect(body.error).toBe('Du kan inte ändra din egen roll.')
    expect(findCalls('company_members', 'update')).toHaveLength(0)
  })

  it("refuses the owner's role (400), for an owner caller too", async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: { ...directMember, role: 'owner' } })

    const { status } = await parseJsonResponse(await patch({ role: 'admin' }))

    expect(status).toBe(400)
    expect(findCalls('company_members', 'update')).toHaveLength(0)
  })

  it('refuses a team-sourced member (400): its role follows the team', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: { ...directMember, role: 'admin', source: 'team' } })

    const { status, body } = await parseJsonResponse<{ error: string }>(await patch({ role: 'member' }))

    expect(status).toBe(400)
    expect(body.error).toMatch(/teamet/)
    expect(findCalls('company_members', 'update')).toHaveLength(0)
  })

  it('refuses demoting the last owner or admin (409)', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: { ...directMember, role: 'admin' } })
    enqueue({ data: null, count: 1 }) // owners and admins of the company

    const { status, body } = await parseJsonResponse<{ error: string }>(await patch({ role: 'viewer' }))

    expect(status).toBe(409)
    expect(body.error).toBe('Företaget måste ha minst en ägare eller administratör.')
    expect(findCalls('company_members', 'in')).toEqual([['role', ['owner', 'admin']]])
    expect(findCalls('company_members', 'update')).toHaveLength(0)
  })

  it('fails closed (500) when the owner and admin count cannot be read', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: { ...directMember, role: 'admin' } })
    enqueue({ data: null, error: { message: 'boom' } })

    const { status } = await parseJsonResponse(await patch({ role: 'viewer' }))

    expect(status).toBe(500)
    expect(findCalls('company_members', 'update')).toHaveLength(0)
  })

  it('refuses (500) a member read without its source column: it may be a team row', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: null }) // lookup with source fails
    enqueue({ data: { id: MEMBER_ID, user_id: 'user-2', role: 'member' } }) // fallback without source

    const { status } = await parseJsonResponse(await patch({ role: 'viewer' }))

    expect(status).toBe(500)
    expect(findCalls('company_members', 'update')).toHaveLength(0)
  })

  it('demotes an admin while another owner or admin remains', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: { ...directMember, role: 'admin' } })
    enqueue({ data: null, count: 2 })
    enqueue({ data: null }) // update

    const { status, body } = await parseJsonResponse<{ data: { role: string } }>(await patch({ role: 'member' }))

    expect(status).toBe(200)
    expect(body.data.role).toBe('member')
    expect(findCalls('company_members', 'update')).toEqual([[{ role: 'member' }]])
  })

  it('changes a member to the invoicing role, scoped to the member and the company', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: directMember })
    enqueue({ data: null }) // update

    const { status, body } = await parseJsonResponse<{ data: { id: string; user_id: string; role: string } }>(
      await patch({ role: 'invoicer' }),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: MEMBER_ID, user_id: 'user-2', role: 'invoicer' })
    expect(findCalls('company_members', 'update')).toEqual([[{ role: 'invoicer' }]])
    // The update filters: id and company (the reads before it filter the same way).
    expect(findCalls('company_members', 'eq').slice(-2)).toEqual([
      ['id', MEMBER_ID],
      ['company_id', 'company-1'],
    ])
    // Only an admin leaving the admin role is counted.
    expect(findCalls('company_members', 'in')).toHaveLength(0)
  })

  it('lets the owner promote a member to admin', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: directMember })
    enqueue({ data: null }) // update

    const { status } = await parseJsonResponse(await patch({ role: 'admin' }))

    expect(status).toBe(200)
    expect(findCalls('company_members', 'update')).toEqual([[{ role: 'admin' }]])
  })

  it('writes nothing when the role is unchanged', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: directMember })

    const { status } = await parseJsonResponse(await patch({ role: 'member' }))

    expect(status).toBe(200)
    expect(findCalls('company_members', 'update')).toHaveLength(0)
  })

  it('returns 500 when the update fails', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: directMember })
    enqueue({ data: null, error: { message: 'boom' } })

    const { status } = await parseJsonResponse(await patch({ role: 'viewer' }))

    expect(status).toBe(500)
  })
})

describe('DELETE /api/company/members/[id] (shared gate)', () => {
  it('returns 403 for a caller who is not owner or admin', async () => {
    enqueue({ data: { role: 'member' } })

    const { status } = await parseJsonResponse(await del())

    expect(status).toBe(403)
    expect(findCalls('company_members', 'delete')).toHaveLength(0)
  })

  it('removes a direct member', async () => {
    enqueue({ data: { role: 'admin' } })
    enqueue({ data: directMember })
    enqueue({ data: null }) // delete

    const { status, body } = await parseJsonResponse<{ data: { removed: string } }>(await del())

    expect(status).toBe(200)
    expect(body.data.removed).toBe(MEMBER_ID)
    expect(findCalls('company_members', 'delete')).toHaveLength(1)
  })

  it('still refuses the owner (400)', async () => {
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: { ...directMember, role: 'owner' } })

    const { status } = await parseJsonResponse(await del())

    expect(status).toBe(400)
    expect(findCalls('company_members', 'delete')).toHaveLength(0)
  })
})
