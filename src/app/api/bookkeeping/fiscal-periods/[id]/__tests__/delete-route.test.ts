import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { createClient } from '@/lib/supabase/server'
import { DELETE } from '../route'

// crm#1450: DELETE removes only an empty first räkenskapsår. Every rule is
// the delete_empty_fiscal_period RPC's; the route maps its answer.

const EMPTY_YEAR = {
  id: 'p-ghost',
  name: 'Räkenskapsår 2025/2026',
  period_start: '2025-03-01',
  period_end: '2026-02-28',
  is_closed: false,
  locked_at: null,
}

function mockSupabase(options: { user?: { id: string } | null; rpc?: { data: unknown; error: unknown } }) {
  const { user = { id: 'user-1' }, rpc = { data: { ok: true, period: EMPTY_YEAR }, error: null } } =
    options
  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
      mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) },
    },
    rpc: vi.fn().mockResolvedValue(rpc),
    from: vi.fn(),
  }
  ;(createClient as ReturnType<typeof vi.fn>).mockResolvedValue(supabase)
  return supabase
}

function deleteRequest(): Request {
  return createMockRequest('/api/bookkeeping/fiscal-periods/p-ghost', { method: 'DELETE' })
}

describe('DELETE /api/bookkeeping/fiscal-periods/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    const supabase = mockSupabase({ user: null })
    const res = await DELETE(deleteRequest(), createMockRouteParams({ id: 'p-ghost' }))
    expect(res.status).toBe(401)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 404 when the year is not the company\'s', async () => {
    mockSupabase({ rpc: { data: { ok: false, code: 'PERIOD_NOT_FOUND' }, error: null } })
    const res = await DELETE(deleteRequest(), createMockRouteParams({ id: 'p-ghost' }))
    expect(res.status).toBe(404)
  })

  it('refuses a year that holds verifikat with 409 and names every blocker', async () => {
    mockSupabase({
      rpc: {
        data: {
          ok: false,
          code: 'FISCAL_PERIOD_DELETE_BLOCKED',
          blockers: [
            { code: 'not_first_year', message_sv: 'Bara företagets första räkenskapsår kan tas bort.' },
            {
              code: 'has_entries',
              message_sv: 'Räkenskapsåret har 3 verifikationer eller utkast. Bara ett tomt räkenskapsår kan tas bort.',
              count: 3,
            },
          ],
        },
        error: null,
      },
    })
    const res = await DELETE(deleteRequest(), createMockRouteParams({ id: 'p-ghost' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details: { blockers: Array<{ code: string }> } }
    }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('FISCAL_PERIOD_DELETE_BLOCKED')
    expect(body.error.message).toContain('Bara företagets första räkenskapsår kan tas bort.')
    expect(body.error.message).toContain('3 verifikationer')
    expect(body.error.details.blockers.map((b) => b.code)).toEqual(['not_first_year', 'has_entries'])
  })

  it('removes an empty first year through the guarded RPC with the acting user', async () => {
    const supabase = mockSupabase({})
    const res = await DELETE(deleteRequest(), createMockRouteParams({ id: 'p-ghost' }))
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(res)
    expect(status).toBe(200)
    expect(body.data.id).toBe('p-ghost')
    expect(supabase.rpc).toHaveBeenCalledWith('delete_empty_fiscal_period', {
      p_company_id: 'company-1',
      p_period_id: 'p-ghost',
      p_user_id: 'user-1',
    })
    // Nothing is written outside the RPC.
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
