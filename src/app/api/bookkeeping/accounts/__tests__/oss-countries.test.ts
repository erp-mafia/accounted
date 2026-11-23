/**
 * POST /api/bookkeeping/accounts/oss-countries: the HTTP contract of the
 * dashboard door. The rules are covered in
 * lib/vat/__tests__/oss-account-countries.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, calls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { POST } from '../oss-countries/route'

const routeCtx = createMockRouteParams({})
const post = (body: unknown) =>
  POST(createMockRequest('/api/bookkeeping/accounts/oss-countries', { method: 'POST', body }), routeCtx)

const SALES = { account_number: '3149', account_name: 'Försäljning OSS Tyskland 19 %', default_vat_treatment: 'oss', oss_country: null, oss_vat_rate: null }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  calls.length = 0
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('POST /api/bookkeeping/accounts/oss-countries', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await post({ accounts: [{ account_number: '3149', country: 'DE', vat_rate: 19 }] })
    expect(response.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('returns 400 for a body without accounts, and for an account without a country field', async () => {
    for (const body of [{}, { accounts: [] }, { accounts: [{ account_number: '3149' }] }, { accounts: [{ country: 'DE' }] }]) {
      const response = await post(body)
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    expect(calls).toEqual([])
  })

  it('returns 404 for an account outside the chart', async () => {
    enqueue({ data: [] })
    const response = await post({ accounts: [{ account_number: '3999', country: 'DE', vat_rate: 19 }] })
    expect(response.status).toBe(404)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(body.error.code).toBe('ACCOUNT_NOT_FOUND')
  })

  it('returns 400 with the reason, in Swedish, for a country the account cannot take', async () => {
    enqueue({ data: [SALES] })
    const response = await post({ accounts: [{ account_number: '3149', country: 'NO', vat_rate: 25 }] })
    expect(response.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toContain('inte ett annat EU-land')
  })

  it('sets the country and the rate, and answers the accounts as they stand', async () => {
    enqueue({ data: [SALES] })
    enqueue({ data: null })

    const response = await post({ accounts: [{ account_number: '3149', country: 'DE', vat_rate: 19 }] })

    expect(response.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: unknown }>(response)
    expect(body.data).toEqual({
      accounts: [{ account_number: '3149', account_name: 'Försäljning OSS Tyskland 19 %', kind: 'sales', oss_country: 'DE', oss_vat_rate: 19 }],
      updated: 1,
      unchanged: 0,
    })
    expect(calls.find((call) => call.method === 'update')?.args[0]).toEqual({ oss_country: 'DE', oss_vat_rate: 19 })
  })
})
