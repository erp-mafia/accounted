import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase, createMockRouteParams } from '@/tests/helpers'

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

import { GET, PUT } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const CA_1 = '11111111-1111-4111-8111-111111111111'

function putReq(body: unknown) {
  return new Request('http://localhost/api/cash-accounts/payee-defaults', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('/api/cash-accounts/payee-defaults', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
    requireWriteMock.mockResolvedValue({ ok: true })
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
  })

  it('GET returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(new Request('http://localhost/api/cash-accounts/payee-defaults'), createMockRouteParams({}))
    expect(response.status).toBe(401)
  })

  it('GET lists bank-type accounts and the defaults, dropping PSP clearing accounts', async () => {
    enqueue({ data: [
      { id: CA_1, ledger_account: '1930', currency: 'SEK' },
      { id: 'stripe', ledger_account: '1686', currency: 'SEK' },
    ] })
    enqueue({ data: [{ id: 'd1', currency: 'SEK', cash_account_id: CA_1 }] })

    const response = await GET(new Request('http://localhost/api/cash-accounts/payee-defaults'), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: { accounts: { id: string }[]; defaults: { currency: string }[] } }>(response)

    expect(status).toBe(200)
    expect(body.data.accounts.map((a) => a.id)).toEqual([CA_1])
    expect(body.data.defaults).toEqual([{ id: 'd1', currency: 'SEK', cash_account_id: CA_1 }])
  })

  it('PUT returns 400 on an unknown currency or a malformed id', async () => {
    expect((await PUT(putReq({ currency: 'CHF', cash_account_id: CA_1 }), createMockRouteParams({}))).status).toBe(400)
    expect((await PUT(putReq({ currency: 'SEK', cash_account_id: 'nope' }), createMockRouteParams({}))).status).toBe(400)
    expect(findCalls('invoice_payee_defaults', 'upsert')).toHaveLength(0)
  })

  it('PUT returns 403 for a member: only owner/admin decide where customers pay', async () => {
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'member', companyId: 'company-1' })
    const response = await PUT(putReq({ currency: 'SEK', cash_account_id: CA_1 }), createMockRouteParams({}))
    expect(response.status).toBe(403)
    expect(findCalls('invoice_payee_defaults', 'upsert')).toHaveLength(0)
  })

  it('PUT returns 404 when the account is not one of the company\'s', async () => {
    enqueue({ data: null })
    const response = await PUT(putReq({ currency: 'SEK', cash_account_id: CA_1 }), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
  })

  it('PUT upserts the default and returns the refreshed state (happy path)', async () => {
    enqueue({ data: { id: CA_1, invoice_payee: true, enabled: true } }) // account lookup
    enqueue({ data: null })                                              // upsert
    enqueue({ data: [{ id: CA_1, ledger_account: '1930', currency: 'SEK' }] })
    enqueue({ data: [{ id: 'd1', currency: 'SEK', cash_account_id: CA_1 }] })

    const response = await PUT(putReq({ currency: 'SEK', cash_account_id: CA_1 }), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: { defaults: { cash_account_id: string }[] } }>(response)

    expect(status).toBe(200)
    expect(body.data.defaults[0].cash_account_id).toBe(CA_1)
    expect(findCalls('invoice_payee_defaults', 'upsert')[0][0]).toEqual({
      company_id: 'company-1',
      currency: 'SEK',
      cash_account_id: CA_1,
    })
  })

  it('PUT with null clears the default for that currency', async () => {
    enqueue({ data: null })  // delete
    enqueue({ data: [] })
    enqueue({ data: [] })

    const response = await PUT(putReq({ currency: 'EUR', cash_account_id: null }), createMockRouteParams({}))
    expect(response.status).toBe(200)
    expect(findCalls('invoice_payee_defaults', 'delete')).toHaveLength(1)
    expect(findCalls('invoice_payee_defaults', 'eq')).toContainEqual(['currency', 'EUR'])
  })
})
