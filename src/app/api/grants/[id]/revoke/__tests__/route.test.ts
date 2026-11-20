import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))
const serviceClient = { service: true }
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => serviceClient),
}))
const stageMock = vi.fn()
vi.mock('@/lib/grants/actions', () => ({
  stageGrantRevocation: (...args: unknown[]) => stageMock(...args),
}))

import { POST } from '../route'

const GRANT = '33333333-3333-4333-8333-333333333333'

function call(id: string) {
  return POST(new Request(`http://localhost/api/grants/${id}/revoke`, { method: 'POST' }), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'anna@example.se' }, supabase: mockSupabase, error: null })
  requireWritePermissionMock.mockResolvedValue({ ok: true })
})

describe('POST /api/grants/:id/revoke', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await call(GRANT)).status).toBe(401)
    expect(stageMock).not.toHaveBeenCalled()
  })

  it('blocks viewers before staging anything', async () => {
    requireWritePermissionMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) })
    expect((await call(GRANT)).status).toBe(403)
    expect(stageMock).not.toHaveBeenCalled()
  })

  it('answers 404 for an id that names no grant', async () => {
    const malformed = await call('not-a-uuid')
    expect(malformed.status).toBe(404)
    expect((await malformed.json()).error.code).toBe('GRANT_NOT_FOUND')
    stageMock.mockResolvedValue({ ok: false, code: 'GRANT_NOT_FOUND', status: 404 })
    expect((await call(GRANT)).status).toBe(404)
  })

  it('answers 409 for a grant that is already revoked', async () => {
    stageMock.mockResolvedValue({ ok: false, code: 'GRANT_ALREADY_REVOKED', status: 409 })
    const res = await call(GRANT)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('GRANT_ALREADY_REVOKED')
  })

  it('stages revoke_grant as the person and answers the operation to approve', async () => {
    stageMock.mockResolvedValue({ ok: true, operationId: 'op-9' })
    const res = await call(GRANT)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { operation_id: 'op-9' } })
    expect(stageMock).toHaveBeenCalledWith(
      mockSupabase,
      serviceClient,
      { companyId: 'company-1', userId: 'user-1', userLabel: 'anna@example.se', grantId: GRANT },
      expect.anything(),
    )
  })
})
