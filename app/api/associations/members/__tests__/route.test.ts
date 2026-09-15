import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { AssociationRegisterError } from '@/lib/associations/errors'

const { supabase, reset } = createQueuedMockSupabase()
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
vi.mock('@/lib/associations/member-register', () => ({
  requireMemberCapitalForm: vi.fn(),
  listMembers: vi.fn(),
  createMember: vi.fn(),
  exitMember: vi.fn(),
}))

import {
  createMember,
  exitMember,
  listMembers,
  requireMemberCapitalForm,
} from '@/lib/associations/member-register'
import { GET, POST } from '../route'
import { PATCH } from '../[id]/route'

const routeParams = { params: Promise.resolve({}) }
const idParams = { params: Promise.resolve({ id: 'm1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  vi.mocked(requireMemberCapitalForm).mockResolvedValue(undefined)
})

describe('GET /api/associations/members', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/associations/members'), routeParams)
    expect(res.status).toBe(401)
  })

  it('refuses a company that is not an ekonomisk förening with 409', async () => {
    vi.mocked(requireMemberCapitalForm).mockRejectedValue(
      new AssociationRegisterError('ASSOCIATION_FORM_REQUIRED'),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/associations/members'), routeParams),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ASSOCIATION_FORM_REQUIRED')
  })

  it('lists members, passing include_exited through', async () => {
    vi.mocked(listMembers).mockResolvedValue([{ id: 'm1', member_number: '1' } as never])
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string }> }>(
      await GET(createMockRequest('/api/associations/members?include_exited=true'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(listMembers).toHaveBeenCalledWith(supabase, 'company-1', { includeExited: true })
  })
})

describe('POST /api/associations/members', () => {
  it('returns 400 for a body without name or admission date', async () => {
    const res = await POST(
      createMockRequest('/api/associations/members', { method: 'POST', body: { member_number: '1' } }),
      routeParams,
    )
    expect(res.status).toBe(400)
    expect(createMember).not.toHaveBeenCalled()
  })

  it('creates a member as the signed-in user and answers 201', async () => {
    vi.mocked(createMember).mockResolvedValue({ id: 'm1', member_number: '1', name: 'Anna' } as never)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(
      await POST(
        createMockRequest('/api/associations/members', {
          method: 'POST',
          body: { member_number: '1', name: 'Anna', admitted_on: '2026-01-10' },
        }),
        routeParams,
      ),
    )
    expect(status).toBe(201)
    expect(body.data.id).toBe('m1')
    expect(createMember).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ member_number: '1', name: 'Anna', admitted_on: '2026-01-10' }),
    )
  })

  it('refuses viewers (requireWrite)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await POST(
      createMockRequest('/api/associations/members', {
        method: 'POST',
        body: { member_number: '1', name: 'Anna', admitted_on: '2026-01-10' },
      }),
      routeParams,
    )
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/associations/members/[id]', () => {
  it('returns 404 for an unknown member', async () => {
    vi.mocked(exitMember).mockRejectedValue(new AssociationRegisterError('ASSOCIATION_MEMBER_NOT_FOUND'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(
        createMockRequest('/api/associations/members/m1', { method: 'PATCH', body: { exited_on: '2026-06-30' } }),
        idParams,
      ),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('ASSOCIATION_MEMBER_NOT_FOUND')
  })

  it('records the exit', async () => {
    vi.mocked(exitMember).mockResolvedValue({ id: 'm1', exited_on: '2026-06-30' } as never)
    const { status, body } = await parseJsonResponse<{ data: { exited_on: string } }>(
      await PATCH(
        createMockRequest('/api/associations/members/m1', { method: 'PATCH', body: { exited_on: '2026-06-30' } }),
        idParams,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.exited_on).toBe('2026-06-30')
    expect(exitMember).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      'm1',
      expect.objectContaining({ exited_on: '2026-06-30', reason: 'exit' }),
    )
  })
})
