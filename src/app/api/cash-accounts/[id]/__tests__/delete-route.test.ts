import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'

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

import { DELETE } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const CA_1931 = '11111111-1111-4111-8111-111111111111'

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } }

describe('DELETE /api/cash-accounts/[id] (#3130: remove a wrongly synced, unbooked account)', () => {
  function deleteReq(query = '') {
    return new Request(`http://localhost/api/cash-accounts/${CA_1931}${query}`, { method: 'DELETE' })
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
    const response = await DELETE(deleteReq(), createMockRouteParams({ id: CA_1931 }))
    expect(response.status).toBe(401)
    expect(rpcCalls()).toHaveLength(0)
  })

  it('returns 403 for a member, without calling the RPC', async () => {
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'member', companyId: 'company-1' })
    const response = await DELETE(deleteReq(), createMockRouteParams({ id: CA_1931 }))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(rpcCalls()).toHaveLength(0)
  })

  it('returns 400 on an unknown query parameter or a dry_run that is not true/false', async () => {
    expect((await DELETE(deleteReq('?dry_run=yes'), createMockRouteParams({ id: CA_1931 }))).status).toBe(400)
    expect((await DELETE(deleteReq('?force=true'), createMockRouteParams({ id: CA_1931 }))).status).toBe(400)
    expect(rpcCalls()).toHaveLength(0)
  })

  it('returns 404 for a non-UUID id without calling the RPC', async () => {
    const response = await DELETE(deleteReq(), createMockRouteParams({ id: 'not-a-uuid' }))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    expect(rpcCalls()).toHaveLength(0)
  })

  it("returns 404 when the RPC finds no such account in the company (another company's id included)", async () => {
    enqueue({ data: { ok: false, reason: 'not_found' } })
    const response = await DELETE(deleteReq(), createMockRouteParams({ id: CA_1931 }))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
  })

  it.each([
    ['bank_connected', 'CASH_ACCOUNT_REMOVE_BANK_CONNECTED', {}],
    ['primary', 'CASH_ACCOUNT_REMOVE_PRIMARY', {}],
    ['booked', 'CASH_ACCOUNT_REMOVE_BOOKED', { transactions: 1 }],
    ['ignored', 'CASH_ACCOUNT_REMOVE_IGNORED', { transactions: 2 }],
    ['match_history', 'CASH_ACCOUNT_REMOVE_MATCH_HISTORY', { transactions: 1 }],
    ['in_use', 'CASH_ACCOUNT_REMOVE_IN_USE', { dependencies: ['invoice-default'] }],
    ['ledger_history', 'CASH_ACCOUNT_REMOVE_LEDGER_HISTORY', { ledger_account: '1931' }],
  ])('maps the refusal %s to 409 %s with a Swedish message and the details', async (reason, code, extra) => {
    enqueue({ data: { ok: false, reason, ...extra } })
    const response = await DELETE(deleteReq(), createMockRouteParams({ id: CA_1931 }))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe(code)
    expect(body.error.message).toMatch(/kontot|Kontot|bankkonto/)
    expect(body.error.details).toMatchObject({ cash_account_id: CA_1931, reason, ...extra })
  })

  it('removes the account and answers what went; the actor is the session user', async () => {
    enqueue({
      data: {
        ok: true,
        dry_run: false,
        cash_account_id: CA_1931,
        ledger_account: '1931',
        deleted_transactions: 162,
        released_underlag: 1,
        released_obligations: 0,
      },
    })
    const response = await DELETE(deleteReq(), createMockRouteParams({ id: CA_1931 }))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)
    expect(status).toBe(200)
    expect(body.data).toEqual({
      cash_account_id: CA_1931,
      ledger_account: '1931',
      deleted_transactions: 162,
      released_underlag: 1,
      released_obligations: 0,
    })
    expect(rpcCalls()).toEqual([
      [
        'remove_cash_account',
        { p_company_id: 'company-1', p_cash_account_id: CA_1931, p_user_id: 'user-1', p_dry_run: false },
      ],
    ])
  })

  it('dry_run=true previews the rows that would go and writes nothing', async () => {
    enqueue({
      data: { ok: true, dry_run: true, cash_account_id: CA_1931, ledger_account: '1931', transactions: 162, underlag: 1 },
    })
    const response = await DELETE(deleteReq('?dry_run=true'), createMockRouteParams({ id: CA_1931 }))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)
    expect(status).toBe(200)
    expect(body.data).toEqual({ cash_account_id: CA_1931, ledger_account: '1931', transactions: 162, underlag: 1 })
    expect(rpcCalls()[0][1]).toMatchObject({ p_dry_run: true })
  })

  it('a concurrent cash-account change answers the retryable busy code', async () => {
    enqueue({ error: { code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY' } })
    const response = await DELETE(deleteReq(), createMockRouteParams({ id: CA_1931 }))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('CASH_ACCOUNT_OPERATION_BUSY')
  })

  it("the database's own owner/admin check answers 403", async () => {
    enqueue({ error: { code: '42501', message: 'CASH_ACCOUNT_REMOVE_ADMIN_ONLY: only company owners and admins can remove a bank account' } })
    const response = await DELETE(deleteReq(), createMockRouteParams({ id: CA_1931 }))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
  })
})
