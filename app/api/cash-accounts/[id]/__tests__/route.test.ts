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
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

import { PATCH } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

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
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: 'ca-1' }))
    expect(response.status).toBe(401)
  })

  it('returns 403 when the caller is a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: 'ca-1' }))
    expect(response.status).toBe(403)
  })

  it('returns 400 on a malformed series (must be one uppercase letter)', async () => {
    for (const bad of ['m', 'AB', '', 7]) {
      const response = await PATCH(patchReq({ voucher_series: bad }), createMockRouteParams({ id: 'ca-1' }))
      expect(response.status).toBe(400)
    }
    expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
  })

  it('returns 400 when voucher_series is missing entirely', async () => {
    const response = await PATCH(patchReq({}), createMockRouteParams({ id: 'ca-1' }))
    expect(response.status).toBe(400)
  })

  it('returns 404 when the account does not belong to the company', async () => {
    enqueue({ data: null, error: null })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: 'ca-other' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    const eqCalls = findCalls('cash_accounts', 'eq')
    expect(eqCalls).toContainEqual(['company_id', 'company-1'])
    expect(eqCalls).toContainEqual(['id', 'ca-other'])
  })

  it('sets the series and returns the updated account (happy path)', async () => {
    enqueue({ data: { id: 'ca-1', ledger_account: '1931', voucher_series: 'M' }, error: null })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: 'ca-1' }))
    const { status, body } = await parseJsonResponse<{ data: { voucher_series: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.voucher_series).toBe('M')
    expect(findCalls('cash_accounts', 'update')).toContainEqual([{ voucher_series: 'M' }])
  })

  it('clears the override with null so the account follows the per-type default again', async () => {
    enqueue({ data: { id: 'ca-1', ledger_account: '1931', voucher_series: null }, error: null })

    const response = await PATCH(patchReq({ voucher_series: null }), createMockRouteParams({ id: 'ca-1' }))
    const { status, body } = await parseJsonResponse<{ data: { voucher_series: string | null } }>(response)

    expect(status).toBe(200)
    expect(body.data.voucher_series).toBeNull()
    expect(findCalls('cash_accounts', 'update')).toContainEqual([{ voucher_series: null }])
  })

  it('maps a database error to the canonical error envelope', async () => {
    enqueue({ data: null, error: { message: 'boom', code: '42P01' } })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: 'ca-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBeGreaterThanOrEqual(400)
    expect(body.error).toBeDefined()
  })
})
