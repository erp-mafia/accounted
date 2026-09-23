import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
const getCompanyRoleMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
  getCompanyRole: (...args: unknown[]) => getCompanyRoleMock(...args),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const CA_1940 = '11111111-1111-4111-8111-111111111111'

/** A manual SEK bank account on 1940, the shape desk crm#59 is about. */
function account(overrides: Record<string, unknown> = {}) {
  return {
    id: CA_1940,
    company_id: 'company-1',
    ledger_account: '1940',
    currency: 'SEK',
    enabled: true,
    is_primary: false,
    bank_connection_id: null,
    source: 'manual',
    ...overrides,
  }
}

describe('POST /api/cash-accounts/[id]/primary (desk crm#59: move primary off the seeded 1930)', () => {
  function postReq() {
    return new Request(`http://localhost/api/cash-accounts/${CA_1940}/primary`, { method: 'POST' })
  }
  const rpcCalls = () => mockSupabase.rpc.mock.calls

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.se' } as never,
      supabase: mockSupabase as never,
      error: null,
    })
    requireWriteMock.mockResolvedValue({ ok: true })
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    expect(response.status).toBe(401)
    expect(rpcCalls()).toHaveLength(0)
  })

  it('returns 403 for a member, without reading the account or calling the RPC', async () => {
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'member', companyId: 'company-1' })
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(rpcCalls()).toHaveLength(0)
  })

  it('returns 404 for an id that is not a UUID, without touching the database', async () => {
    const response = await POST(postReq(), createMockRouteParams({ id: 'ca-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    expect(getCompanyRoleMock).not.toHaveBeenCalled()
  })

  const RPC = ['make_cash_account_primary', { p_company_id: 'company-1', p_cash_account_id: CA_1940 }]

  it('returns 404 when the RPC finds no such account in the company', async () => {
    enqueue({ data: null, error: { message: 'CASH_ACCOUNT_NOT_FOUND', code: 'P0002' } })
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    expect(rpcCalls()).toEqual([RPC])
  })

  // The rule itself lives in the RPC (one transaction with the swap) and is
  // proven in tests/pg/cash-accounts-routing-audit.pg.test.ts. Here: each
  // refusal it raises becomes a 400 with its reason.
  it.each(['disabled', 'not_sek', 'not_bank_account'])(
    'returns 400 with the reason when the RPC refuses the target as %s',
    async (reason) => {
      enqueue({ data: null, error: { message: `CASH_ACCOUNT_PRIMARY_INELIGIBLE: ${reason}`, code: '23514' } })
      const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
      const { status, body } = await parseJsonResponse<{
        error: { code: string; details?: { reason?: string } }
      }>(response)
      expect(status).toBe(400)
      expect(body.error.code).toBe('CASH_ACCOUNT_PRIMARY_INELIGIBLE')
      expect(body.error.details?.reason).toBe(reason)
    },
  )

  it('returns 403 when the database\'s own owner/admin check refuses', async () => {
    enqueue({ data: null, error: { message: 'CASH_ACCOUNT_PRIMARY_ADMIN_ONLY: only owner or admin', code: '42501' } })
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('makes the account primary through make_cash_account_primary and returns the row', async () => {
    enqueue({ data: account({ is_primary: true }) })
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    const { status, body } = await parseJsonResponse<{ data: { id: string; is_primary: boolean } }>(response)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ id: CA_1940, is_primary: true })
    expect(rpcCalls()).toEqual([RPC])
  })

  // Hard Rule 1: moving the primary is a settings change. The route reaches
  // the database through the one RPC and no table at all.
  it('calls the RPC and touches no table: no journal table, no transaction', async () => {
    enqueue({ data: account({ is_primary: true }) })
    await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    expect(mockSupabase.from.mock.calls).toHaveLength(0)
    expect(rpcCalls()).toHaveLength(1)
  })

  it('never calls set_cash_account_primary: that one has no eligibility rule', async () => {
    enqueue({ data: account({ is_primary: true }) })
    await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    expect(rpcCalls().map((c) => c[0])).not.toContain('set_cash_account_primary')
  })

  it('maps any other RPC failure to the canonical error envelope', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBeGreaterThanOrEqual(500)
    expect(body.error.code).toBeTruthy()
  })
})
