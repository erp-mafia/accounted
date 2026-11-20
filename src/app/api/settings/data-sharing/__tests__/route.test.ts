import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const COMPANY = '11111111-1111-4111-8111-111111111111'

const user = createQueuedMockSupabase()
const service = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...a: unknown[]) => requireAuthMock(...a) }))

const getActiveCompanyIdMock = vi.fn()
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: (...a: unknown[]) => getActiveCompanyIdMock(...a),
  requireCompanyId: vi.fn(),
}))

const isAdminMock = vi.fn()
vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return {
    requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
    isCompanyAdmin: (...a: unknown[]) => isAdminMock(...a),
    companyAdminRequiredResponse: actual.companyAdminRequiredResponse,
  }
})

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => service.supabase }))

import { GET, PATCH } from '../route'

const routeParams = { params: Promise.resolve({}) }
const patch = (body: unknown) => PATCH(createMockRequest('/api/settings/data-sharing', { method: 'PATCH', body }), routeParams)

beforeEach(() => {
  vi.clearAllMocks()
  user.reset()
  service.reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: user.supabase, error: null })
  getActiveCompanyIdMock.mockResolvedValue(COMPANY)
  isAdminMock.mockResolvedValue(true)
})

describe('GET /api/settings/data-sharing', () => {
  it('401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await GET(createMockRequest('/api/settings/data-sharing'), routeParams)).status).toBe(401)
  })

  it('answers the company\'s choices with the defaults filled in', async () => {
    user.enqueue({ data: [{ capability_key: 'ai', enabled: false }] })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await GET(createMockRequest('/api/settings/data-sharing'), routeParams))
    expect(status).toBe(200)
    expect(body.data).toEqual({ ai: false, pooling: true, contribution: false })
  })
})

describe('PATCH /api/settings/data-sharing', () => {
  it('401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await patch({ ai: false })).status).toBe(401)
  })

  it('403 for a member who is not an owner or admin, before anything is written', async () => {
    isAdminMock.mockResolvedValue(false)
    expect((await patch({ ai: false })).status).toBe(403)
    expect(service.supabase.rpc).not.toHaveBeenCalled()
  })

  it('400 on an empty or unknown choice', async () => {
    expect((await patch({})).status).toBe(400)
    expect((await patch({ marketing: true })).status).toBe(400)
    expect((await patch({ ai: 'off' })).status).toBe(400)
  })

  it('writes each choice sent through set_company_data_choice and answers the new state', async () => {
    service.enqueue({ data: { ok: true, unchanged: false, enabled: false } })
    service.enqueue({ data: { ok: true, unchanged: false, enabled: false } })
    user.enqueue({ data: [{ capability_key: 'ai', enabled: false }, { capability_key: 'data:pooling', enabled: false }] })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await patch({ ai: false, pooling: false }))
    expect(status).toBe(200)
    expect(body.data).toEqual({ ai: false, pooling: false, contribution: false })
    expect(service.supabase.rpc).toHaveBeenCalledWith('set_company_data_choice', expect.objectContaining({ p_key: 'ai', p_enabled: false, p_decided_by: 'user-1', p_company_id: COMPANY }))
    expect(service.supabase.rpc).toHaveBeenCalledWith('set_company_data_choice', expect.objectContaining({ p_key: 'data:pooling', p_enabled: false }))
  })

  it('403 when the database refuses the decider', async () => {
    service.enqueue({ data: { ok: false, code: 'DATA_CHOICE_ADMIN_REQUIRED' } })
    expect((await patch({ contribution: true })).status).toBe(403)
  })
})
