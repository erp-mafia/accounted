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
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'maybeSingle', 'single']) {
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

/**
 * bas-lookup answers "can this number be activated at all?", which is what
 * gates ActivateAccountsDialog's confirm button. It consults the company's own
 * chart first, so a custom (non-BAS) account the company deactivated still
 * comes back known — before that it read as unknown and the button stayed dead.
 */
describe('GET /api/bookkeeping/accounts/bas-lookup', () => {
  function authWith(chartRows: unknown[]) {
    const { supabase, calls } = createCapturingSupabase([{ data: chartRows }])
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    return calls
  }

  beforeEach(() => {
    authWith([])
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await basLookupGET(
      createMockRequest('/api/bookkeeping/accounts/bas-lookup'),
      routeParams
    )
    expect(res.status).toBe(401)
  })

  it('resolves known BAS numbers and flags unknown ones', async () => {
    const req = createMockRequest('/api/bookkeeping/accounts/bas-lookup', {
      searchParams: { numbers: '1930,0000' },
    })
    const { status, body } = await parseJsonResponse<{
      data: Array<{ account_number: string; known: boolean; in_chart: boolean }>
    }>(await basLookupGET(req, routeParams))

    expect(status).toBe(200)
    const bas = body.data.find((a) => a.account_number === '1930')
    expect(bas?.known).toBe(true)
    // Known from the static catalog, not held by the company: activating it
    // inserts a new row rather than reviving one.
    expect(bas?.in_chart).toBe(false)
    expect(body.data.find((a) => a.account_number === '0000')?.known).toBe(false)
  })

  it('reports a deactivated custom account as known and in the chart', async () => {
    const calls = authWith([
      {
        account_number: '3910',
        account_name: 'Hyresintäkter egen',
        account_class: 3,
        account_type: 'revenue',
        is_active: false,
      },
    ])
    const req = createMockRequest('/api/bookkeeping/accounts/bas-lookup', {
      searchParams: { numbers: '3910' },
    })
    const { status, body } = await parseJsonResponse<{
      data: Array<{
        account_number: string
        account_name: string | null
        known: boolean
        in_chart: boolean
        is_active: boolean
      }>
    }>(await basLookupGET(req, routeParams))

    expect(status).toBe(200)
    // 3910 is not in the BAS catalog: without the chart read this was known:false.
    const row = body.data[0]
    expect(row.known).toBe(true)
    expect(row.in_chart).toBe(true)
    expect(row.is_active).toBe(false)
    expect(row.account_name).toBe('Hyresintäkter egen')
    // Defense in depth alongside RLS: another company's chart must not answer.
    expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toContainEqual([
      'company_id',
      'company-1',
    ])
  })

  it("prefers the company's own account name over the BAS catalog name", async () => {
    authWith([
      {
        account_number: '1930',
        account_name: 'Företagskonto SEB',
        account_class: 1,
        account_type: 'asset',
        is_active: true,
      },
    ])
    const req = createMockRequest('/api/bookkeeping/accounts/bas-lookup', {
      searchParams: { numbers: '1930' },
    })
    const { body } = await parseJsonResponse<{
      data: Array<{ account_name: string | null; in_chart: boolean }>
    }>(await basLookupGET(req, routeParams))

    expect(body.data[0].account_name).toBe('Företagskonto SEB')
    expect(body.data[0].in_chart).toBe(true)
  })

  it('rejects an oversized numbers list with 400', async () => {
    const many = Array.from({ length: 2001 }, (_, i) => String(10000 + i)).join(',')
    const req = createMockRequest('/api/bookkeeping/accounts/bas-lookup', {
      searchParams: { numbers: many },
    })
    const { status } = await parseJsonResponse(await basLookupGET(req, routeParams))
    expect(status).toBe(400)
  })
})
