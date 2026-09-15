import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/company/entity-type-preview', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/company/entity-type-preview?target=ekonomisk_forening'), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 for a target that is not a supported form, without calling the database', async () => {
    const res = await GET(createMockRequest('/api/company/entity-type-preview?target=handelsbolag'), routeParams)
    expect(res.status).toBe(400)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns the RPC assessment', async () => {
    enqueue({
      data: {
        ok: true,
        current_entity_type: 'aktiebolag',
        target_entity_type: 'ekonomisk_forening',
        empty_books_path_available: false,
        blockers: { journal_entries: 12 },
        decision_accounts: [{ account: '2081', balance: 25000 }],
      },
    })
    const { status, body } = await parseJsonResponse<{ data: { empty_books_path_available: boolean } }>(
      await GET(createMockRequest('/api/company/entity-type-preview?target=ekonomisk_forening'), routeParams),
    )
    expect(status).toBe(200)
    expect(body.data.empty_books_path_available).toBe(false)
    expect(supabase.rpc).toHaveBeenCalledWith('preview_company_entity_type_change', {
      p_company_id: 'company-1',
      p_entity_type: 'ekonomisk_forening',
    })
  })

  it('maps an outsider refusal to 404', async () => {
    enqueue({ data: { ok: false, code: 'ENTITY_TYPE_CHANGE_NOT_FOUND' } })
    const res = await GET(createMockRequest('/api/company/entity-type-preview?target=ekonomisk_forening'), routeParams)
    expect(res.status).toBe(404)
  })
})
