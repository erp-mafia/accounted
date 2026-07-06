/**
 * Tests for /api/bookkeeping/accounts (list/create), /[number] (update/delete)
 * and /activate.
 *
 * The DELETE usage check is asserted with a call-capturing mock: the count
 * query must be scoped to the caller's company via the journal_entries join —
 * without it, another company's use of the same BAS number (same user,
 * multiple memberships under RLS) wrongly blocks deletion.
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

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { GET as listGET, POST as createPOST } from '../route'
import { DELETE, PUT } from '../[number]/route'
import { POST as activatePOST } from '../activate/route'

interface CapturedCall {
  method: string
  args: unknown[]
}

/** Chainable builder recording calls; resolves queued {data,error,count} per from(). */
function createCapturingSupabase(
  results: { data?: unknown; error?: unknown; count?: number | null }[]
) {
  const calls: CapturedCall[] = []
  let idx = 0
  const makeBuilder = () => {
    const result = results[idx++] ?? { data: null, error: null, count: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'is', 'order', 'limit', 'range', 'insert', 'update', 'delete', 'maybeSingle', 'single']) {
      b[m] = (...args: unknown[]) => {
        calls.push({ method: m, args })
        return b
      }
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null })
    return b
  }
  const supabase = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] })
      return makeBuilder()
    },
  }
  return { supabase, calls }
}

const routeParams = { params: Promise.resolve({}) }
const numberParams = { params: Promise.resolve({ number: '5010' }) }

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

function auth(supabase: unknown) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

describe('GET /api/bookkeeping/accounts', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await listGET(createMockRequest('/api/bookkeeping/accounts'), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 for a non-numeric class filter', async () => {
    const { supabase } = createCapturingSupabase([])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts', { searchParams: { class: 'abc' } })
    const { status } = await parseJsonResponse(await listGET(req, routeParams))
    expect(status).toBe(400)
  })

  it('lists accounts for the company', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: [{ account_number: '1930', account_name: 'Företagskonto' }] },
    ])
    auth(supabase)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(
      await listGET(createMockRequest('/api/bookkeeping/accounts'), routeParams)
    )
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toContainEqual([
      'company_id',
      'company-1',
    ])
  })
})

describe('POST /api/bookkeeping/accounts', () => {
  it('returns 409 with a Swedish message on duplicate account number', async () => {
    const { supabase } = createCapturingSupabase([{ error: { code: '23505', message: 'dup' } }])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts', {
      method: 'POST',
      body: {
        account_number: '5010',
        account_name: 'Lokalhyra',
        account_type: 'expense',
        normal_balance: 'debit',
      },
    })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await createPOST(req, routeParams)
    )
    expect(status).toBe(409)
    expect(body.error).toContain('5010')
  })
})

describe('DELETE /api/bookkeeping/accounts/[number]', () => {
  it('scopes the usage check to the company via the journal_entries join', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { id: 'acc-1', is_system_account: false } }, // account fetch
      { count: 0 }, // usage count
      { data: null }, // delete
    ])
    auth(supabase)

    const { status } = await parseJsonResponse(
      await DELETE(createMockRequest('/api/bookkeeping/accounts/5010'), numberParams)
    )

    expect(status).toBe(200)
    const selectArgs = calls.filter((c) => c.method === 'select').map((c) => c.args[0])
    expect(selectArgs).toContain('id, journal_entries!inner(company_id)')
    const eqCalls = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqCalls).toContainEqual(['journal_entries.company_id', 'company-1'])
  })

  it('refuses deleting an account used in this company with 400', async () => {
    const { supabase } = createCapturingSupabase([
      { data: { id: 'acc-1', is_system_account: false } },
      { count: 3 },
    ])
    auth(supabase)

    const { status, body } = await parseJsonResponse<{ error: string }>(
      await DELETE(createMockRequest('/api/bookkeeping/accounts/5010'), numberParams)
    )
    expect(status).toBe(400)
    expect(body.error).toContain('Inaktivera')
  })

  it('refuses deleting a system account', async () => {
    const { supabase } = createCapturingSupabase([
      { data: { id: 'acc-1', is_system_account: true } },
    ])
    auth(supabase)

    const { status } = await parseJsonResponse(
      await DELETE(createMockRequest('/api/bookkeeping/accounts/5010'), numberParams)
    )
    expect(status).toBe(400)
  })
})

describe('PUT /api/bookkeeping/accounts/[number]', () => {
  it('returns 400 when the body has nothing to update', async () => {
    const { supabase } = createCapturingSupabase([])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/5010', { method: 'PUT', body: {} })
    const { status } = await parseJsonResponse(await PUT(req, numberParams))
    expect(status).toBe(400)
  })

  it('maps zero-rows (PGRST116) to 404', async () => {
    const { supabase } = createCapturingSupabase([
      { error: { code: 'PGRST116', message: 'no rows' } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/5010', {
      method: 'PUT',
      body: { account_name: 'Nytt namn' },
    })
    const { status, body } = await parseJsonResponse<{ error: string }>(await PUT(req, numberParams))
    expect(status).toBe(404)
    expect(body.error).toBe('Kontot hittades inte')
  })

  it('updates the account', async () => {
    const { supabase } = createCapturingSupabase([
      { data: { account_number: '5010', account_name: 'Nytt namn' } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/5010', {
      method: 'PUT',
      body: { account_name: 'Nytt namn' },
    })
    const { status, body } = await parseJsonResponse<{ data: { account_name: string } }>(
      await PUT(req, numberParams)
    )
    expect(status).toBe(200)
    expect(body.data.account_name).toBe('Nytt namn')
  })
})

describe('POST /api/bookkeeping/accounts/activate', () => {
  it('returns 400 (not a crash) on invalid JSON', async () => {
    const { supabase } = createCapturingSupabase([])
    auth(supabase)
    const req = new Request('http://localhost/api/bookkeeping/accounts/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await activatePOST(req, routeParams)
    )
    expect(status).toBe(400)
    expect(body.error).toBe('account_numbers array required')
  })

  it('returns 400 when account_numbers is missing or empty', async () => {
    const { supabase } = createCapturingSupabase([])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/activate', {
      method: 'POST',
      body: { account_numbers: [] },
    })
    const { status } = await parseJsonResponse(await activatePOST(req, routeParams))
    expect(status).toBe(400)
  })

  it('activates a known BAS account and buckets unknown numbers', async () => {
    const { supabase } = createCapturingSupabase([
      { data: [] }, // existing lookup — none in chart
      { data: [{ account_number: '1930' }] }, // insert result
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/activate', {
      method: 'POST',
      body: { account_numbers: ['1930', '0000'] },
    })
    const { status, body } = await parseJsonResponse<{
      activated: number
      unknown: string[]
    }>(await activatePOST(req, routeParams))

    expect(status).toBe(200)
    expect(body.activated).toBe(1)
    expect(body.unknown).toEqual(['0000'])
  })
})
