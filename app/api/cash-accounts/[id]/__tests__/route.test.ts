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

import { PATCH } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const CA_1 = '11111111-1111-4111-8111-111111111111'
const CA_OTHER = '22222222-2222-4222-8222-222222222222'

describe('PATCH /api/cash-accounts/[id] (verifikationsserie per bankkonto)', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  function patchReq(body: unknown) {
    return new Request('http://localhost/api/cash-accounts/ca-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

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

  it('payee fields: 403 for a member, no role lookup for a pure voucher_series write', async () => {
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'member', companyId: 'company-1' })
    const forbidden = await PATCH(patchReq({ bankgiro: '5050-1055' }), createMockRouteParams({ id: CA_1 }))
    expect(forbidden.status).toBe(403)
    expect(findCalls('cash_accounts', 'update')).toHaveLength(0)

    enqueue({ data: { id: CA_1, voucher_series: 'M' } })
    const series = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_1 }))
    expect(series.status).toBe(200)
    expect(getCompanyRoleMock).toHaveBeenCalledTimes(1)
  })

  it('payee fields: 400 on an invalid bankgiro or an unknown key', async () => {
    expect((await PATCH(patchReq({ bankgiro: '12' }), createMockRouteParams({ id: CA_1 }))).status).toBe(400)
    expect((await PATCH(patchReq({ ledger_account: '1931' }), createMockRouteParams({ id: CA_1 }))).status).toBe(400)
    expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
  })

  it('payee fields: owner writes bankgiro, clears plusgiro with "", and flags the account as payee', async () => {
    enqueue({ data: { id: CA_1, bankgiro: '5050-1055', plusgiro: null, invoice_payee: true } })
    const response = await PATCH(
      patchReq({ bankgiro: '5050-1055', plusgiro: '', invoice_payee: true }),
      createMockRouteParams({ id: CA_1 }),
    )
    const { status, body } = await parseJsonResponse<{ data: { bankgiro: string } }>(response)
    expect(status).toBe(200)
    expect(body.data.bankgiro).toBe('5050-1055')
    expect(findCalls('cash_accounts', 'update')).toEqual([[{ bankgiro: '5050-1055', plusgiro: null, invoice_payee: true }]])
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_1 }))
    expect(response.status).toBe(401)
  })

  it('returns 403 when the caller is a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_1 }))
    expect(response.status).toBe(403)
  })

  it('returns 400 on a malformed series (must be one uppercase letter)', async () => {
    for (const bad of ['m', 'AB', '', 7]) {
      const response = await PATCH(patchReq({ voucher_series: bad }), createMockRouteParams({ id: CA_1 }))
      expect(response.status).toBe(400)
    }
    expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
  })

  it('returns 400 when voucher_series is missing entirely', async () => {
    const response = await PATCH(patchReq({}), createMockRouteParams({ id: CA_1 }))
    expect(response.status).toBe(400)
  })

  it('returns 404 for an id that is not a UUID, without touching the database', async () => {
    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: 'not-a-uuid' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
  })

  it('returns 404 when the account does not belong to the company', async () => {
    enqueue({ data: null, error: null })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_OTHER }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    const eqCalls = findCalls('cash_accounts', 'eq')
    expect(eqCalls).toContainEqual(['company_id', 'company-1'])
    expect(eqCalls).toContainEqual(['id', CA_OTHER])
  })

  it('sets the series and returns the updated account (happy path)', async () => {
    enqueue({ data: { id: 'ca-1', ledger_account: '1931', voucher_series: 'M' }, error: null })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_1 }))
    const { status, body } = await parseJsonResponse<{ data: { voucher_series: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.voucher_series).toBe('M')
    expect(findCalls('cash_accounts', 'update')).toContainEqual([{ voucher_series: 'M' }])
  })

  it('clears the override with null so the account follows the per-type default again', async () => {
    enqueue({ data: { id: 'ca-1', ledger_account: '1931', voucher_series: null }, error: null })

    const response = await PATCH(patchReq({ voucher_series: null }), createMockRouteParams({ id: CA_1 }))
    const { status, body } = await parseJsonResponse<{ data: { voucher_series: string | null } }>(response)

    expect(status).toBe(200)
    expect(body.data.voucher_series).toBeNull()
    expect(findCalls('cash_accounts', 'update')).toContainEqual([{ voucher_series: null }])
  })

  it('maps a database error to the canonical error envelope', async () => {
    enqueue({ data: null, error: { message: 'boom', code: '42P01' } })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_1 }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBeGreaterThanOrEqual(400)
    expect(body.error).toBeDefined()
  })
})
