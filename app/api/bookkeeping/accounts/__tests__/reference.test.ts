/**
 * Tests for GET /api/bookkeeping/accounts/reference and /bas-lookup.
 *
 * reference: the chart query must carry a stable unique order — a full-BAS
 * chart exceeds fetchAllRows' 1000-row page size and unordered .range()
 * paging can duplicate/skip rows on page boundaries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET as referenceGET } from '../reference/route'
import { GET as basLookupGET } from '../bas-lookup/route'

const routeParams = { params: Promise.resolve({}) }

function createCapturingSupabase(results: { data?: unknown; error?: unknown }[]) {
  const calls: { method: string; args: unknown[] }[] = []
  let idx = 0
  const makeBuilder = () => {
    const result = results[idx++] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'eq', 'order', 'range', 'maybeSingle', 'single']) {
      b[m] = (...args: unknown[]) => {
        calls.push({ method: m, args })
        return b
      }
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null, count: null })
    return b
  }
  return {
    supabase: { from: () => makeBuilder() },
    calls,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/bookkeeping/accounts/reference', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await referenceGET(createMockRequest('/api/bookkeeping/accounts/reference'), routeParams)
    expect(res.status).toBe(401)
  })

  it('pages the chart with a stable account_number order and returns activation status', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: [{ account_number: '1930', is_active: true, is_system_account: false }] },
    ])
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const { status, body } = await parseJsonResponse<{
      data: Array<{ account_number: string; is_active: boolean; is_system_account: boolean }>
    }>(await referenceGET(createMockRequest('/api/bookkeeping/accounts/reference'), routeParams))

    expect(status).toBe(200)
    // The route returns only the company's activation rows; the BAS catalog is
    // merged client-side against the bundled reference data.
    const row = body.data.find((a) => a.account_number === '1930')
    expect(row?.is_active).toBe(true)
    expect(row?.is_system_account).toBe(false)
    // Paging-stability regression guard.
    expect(calls.filter((c) => c.method === 'order').map((c) => c.args[0])).toContain(
      'account_number'
    )
  })
})

describe('GET /api/bookkeeping/accounts/bas-lookup', () => {
  beforeEach(() => {
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await basLookupGET(createMockRequest('/api/bookkeeping/accounts/bas-lookup'))
    expect(res.status).toBe(401)
  })

  it('resolves known BAS numbers and flags unknown ones', async () => {
    const req = createMockRequest('/api/bookkeeping/accounts/bas-lookup', {
      searchParams: { numbers: '1930,0000' },
    })
    const { status, body } = await parseJsonResponse<{
      data: Array<{ account_number: string; known: boolean }>
    }>(await basLookupGET(req))

    expect(status).toBe(200)
    expect(body.data.find((a) => a.account_number === '1930')?.known).toBe(true)
    expect(body.data.find((a) => a.account_number === '0000')?.known).toBe(false)
  })

  it('rejects an oversized numbers list with 400', async () => {
    const many = Array.from({ length: 2001 }, (_, i) => String(10000 + i)).join(',')
    const req = createMockRequest('/api/bookkeeping/accounts/bas-lookup', {
      searchParams: { numbers: many },
    })
    const { status } = await parseJsonResponse(await basLookupGET(req))
    expect(status).toBe(400)
  })
})
