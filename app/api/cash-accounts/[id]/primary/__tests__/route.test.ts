import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
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
    expect(findCalls('cash_accounts', 'select')).toHaveLength(0)
    expect(rpcCalls()).toHaveLength(0)
  })

  it('returns 404 for an id that is not a UUID, without touching the database', async () => {
    const response = await POST(postReq(), createMockRouteParams({ id: 'ca-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    expect(getCompanyRoleMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the account is not one of the company\'s', async () => {
    enqueue({ data: null }) // company-scoped lookup finds nothing
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    expect(findCalls('cash_accounts', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(rpcCalls()).toHaveLength(0)
  })

  it.each([
    ['a disabled account', { enabled: false }, 'disabled'],
    ['a currency account', { currency: 'EUR', ledger_account: '1950' }, 'not_sek'],
    ['a PSP clearing account', { ledger_account: '1686' }, 'not_bank_account'],
    ['a till', { ledger_account: '1910' }, 'not_bank_account'],
  ])('returns 400 for %s and never calls the RPC', async (_label, overrides, reason) => {
    enqueue({ data: account(overrides) })
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { reason?: string } }
    }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('CASH_ACCOUNT_PRIMARY_INELIGIBLE')
    expect(body.error.details?.reason).toBe(reason)
    expect(rpcCalls()).toHaveLength(0)
  })

  it('makes an enabled SEK bank account primary through set_cash_account_primary and returns it', async () => {
    enqueue({ data: account() }) // lookup
    enqueue({ data: { id: 'ca-1930' } }) // current primary
    enqueue({ data: null }) // rpc
    enqueue({ data: account({ is_primary: true }) }) // re-read
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    const { status, body } = await parseJsonResponse<{ data: { id: string; is_primary: boolean } }>(response)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ id: CA_1940, is_primary: true })
    expect(rpcCalls()).toEqual([
      ['set_cash_account_primary', { p_company_id: 'company-1', p_cash_account_id: CA_1940 }],
    ])
  })

  // Hard Rule 1: moving the primary is a settings change. It must not read or
  // write a journal table or a transaction; only later bookings follow it.
  it('touches cash_accounts and the RPC only: no journal table, no transaction', async () => {
    enqueue({ data: account() })
    enqueue({ data: { id: 'ca-1930' } }) // current primary
    enqueue({ data: null })
    enqueue({ data: account({ is_primary: true }) })
    await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    const tables = mockSupabase.from.mock.calls.map((c) => c[0])
    expect(new Set(tables)).toEqual(new Set(['cash_accounts']))
    expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
    expect(findCalls('cash_accounts', 'insert')).toHaveLength(0)
    expect(findCalls('cash_accounts', 'delete')).toHaveLength(0)
  })

  it('allows an account a bank connection holds: the PSD2 sync never picks a primary', async () => {
    enqueue({ data: account({ bank_connection_id: 'conn-1', source: 'enable_banking' }) })
    enqueue({ data: { id: 'ca-1930' } }) // current primary
    enqueue({ data: null })
    enqueue({ data: account({ bank_connection_id: 'conn-1', source: 'enable_banking', is_primary: true }) })
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    expect(response.status).toBe(200)
    expect(rpcCalls()).toHaveLength(1)
  })

  // Superagent P2: the RPC only checks that the row exists, so a disable that
  // commits between the eligibility read and the swap would leave a disabled
  // primary. The re-read after the swap catches it and the flag goes back.
  it('hands primary back and answers 400 when the target was disabled between the check and the swap', async () => {
    enqueue({ data: account() }) // lookup: eligible
    enqueue({ data: { id: 'ca-1930' } }) // current primary
    enqueue({ data: null }) // rpc: swap to 1940
    enqueue({ data: account({ is_primary: true, enabled: false }) }) // re-read: disabled meanwhile
    enqueue({ data: null }) // rpc: back to 1930
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { reason?: string } }
    }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('CASH_ACCOUNT_PRIMARY_INELIGIBLE')
    expect(body.error.details?.reason).toBe('disabled')
    expect(rpcCalls()).toEqual([
      ['set_cash_account_primary', { p_company_id: 'company-1', p_cash_account_id: CA_1940 }],
      ['set_cash_account_primary', { p_company_id: 'company-1', p_cash_account_id: 'ca-1930' }],
    ])
  })

  it('is a no-op on the account that is already primary', async () => {
    enqueue({ data: account({ is_primary: true }) })
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    expect(response.status).toBe(200)
    expect(rpcCalls()).toHaveLength(0)
  })

  it('maps an RPC failure to the canonical error envelope', async () => {
    enqueue({ data: account() })
    enqueue({ data: { id: 'ca-1930' } }) // current primary
    enqueue({ data: null, error: { message: 'boom' } })
    const response = await POST(postReq(), createMockRouteParams({ id: CA_1940 }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBeGreaterThanOrEqual(500)
    expect(body.error.code).toBeTruthy()
  })
})
