/**
 * Tests for /api/bookkeeping/accounts/usage and /prune.
 *
 * The prune execute phase is the safety-critical part: the client's
 * account_numbers list is a selection, not an authority. The tests assert
 * that used accounts, system accounts, and unknown numbers sent by the
 * client are skipped/reported — only freshly re-verified unused accounts
 * reach the DELETE.
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

import { GET as usageGET } from '../usage/route'
import { POST as prunePOST } from '../prune/route'

interface CapturedCall {
  method: string
  args: unknown[]
}

/**
 * Chainable builder recording calls; resolves queued {data,error} per
 * from()/rpc() invocation, in call order.
 */
function createCapturingSupabase(results: { data?: unknown; error?: unknown }[]) {
  const calls: CapturedCall[] = []
  let idx = 0
  const nextResult = () => results[idx++] ?? { data: null, error: null }
  const makeBuilder = () => {
    const result = nextResult()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'insert', 'update', 'delete']) {
      b[m] = (...args: unknown[]) => {
        calls.push({ method: m, args })
        return b
      }
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null })
    return b
  }
  const supabase = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] })
      return makeBuilder()
    },
    rpc: (fn: string, params: unknown) => {
      calls.push({ method: 'rpc', args: [fn, params] })
      const result = nextResult()
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null })
    },
  }
  return { supabase, calls }
}

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

function auth(supabase: unknown) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function unauthenticated() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase: {},
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

// Chart fixture: one system account, one used BAS account, one unused BAS
// account from the seed, one unused imported custom account.
const chartAccounts = [
  { account_number: '1930', account_name: 'Företagskonto', account_class: 1, plan_type: 'k1', is_active: true, is_system_account: true },
  { account_number: '3001', account_name: 'Försäljning', account_class: 3, plan_type: 'k1', is_active: true, is_system_account: false },
  { account_number: '5410', account_name: 'Förbrukningsinventarier', account_class: 5, plan_type: 'k1', is_active: true, is_system_account: false },
  { account_number: '19301', account_name: 'Sparkonto (import)', account_class: 1, plan_type: 'full_bas', is_active: true, is_system_account: false },
]

const usageRows = [
  { account_number: '1930', usage_count: 12 },
  { account_number: '3001', usage_count: 4 },
]

describe('GET /api/bookkeeping/accounts/usage', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await usageGET(createMockRequest('/api/bookkeeping/accounts/usage'), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns per-account usage counts from the RPC, company-scoped', async () => {
    const { supabase, calls } = createCapturingSupabase([{ data: usageRows }])
    auth(supabase)

    const { status, body } = await parseJsonResponse<{ data: typeof usageRows }>(
      await usageGET(createMockRequest('/api/bookkeeping/accounts/usage'), routeParams),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual(usageRows)
    expect(calls.filter((c) => c.method === 'rpc').map((c) => c.args)).toContainEqual([
      'get_account_usage_counts',
      { p_company_id: 'company-1' },
    ])
  })

  it('returns 500 when the RPC fails', async () => {
    const { supabase } = createCapturingSupabase([{ error: { message: 'boom' } }])
    auth(supabase)
    const res = await usageGET(createMockRequest('/api/bookkeeping/accounts/usage'), routeParams)
    expect(res.status).toBe(500)
  })
})

describe('POST /api/bookkeeping/accounts/prune', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const req = createMockRequest('/api/bookkeeping/accounts/prune', {
      method: 'POST',
      body: { dry_run: true },
    })
    const res = await prunePOST(req, routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 when dry_run is false and account_numbers is missing', async () => {
    const { supabase } = createCapturingSupabase([])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/prune', {
      method: 'POST',
      body: { dry_run: false },
    })
    const { status } = await parseJsonResponse(await prunePOST(req, routeParams))
    expect(status).toBe(400)
  })

  it('dry_run returns unused non-system accounts as deletable, the rest as used', async () => {
    const { supabase } = createCapturingSupabase([
      { data: chartAccounts }, // chart_of_accounts page
      { data: usageRows }, // usage RPC
    ])
    auth(supabase)

    const req = createMockRequest('/api/bookkeeping/accounts/prune', {
      method: 'POST',
      body: { dry_run: true },
    })
    const { status, body } = await parseJsonResponse<{
      data: {
        deletable: Array<{ account_number: string; in_bas_reference: boolean }>
        used: Array<{ account_number: string; usage_count: number }>
      }
    }>(await prunePOST(req, routeParams))

    expect(status).toBe(200)
    const deletableNumbers = body.data.deletable.map((a) => a.account_number).sort()
    // Unused + non-system: the seeded 5410 and the imported 19301.
    expect(deletableNumbers).toEqual(['19301', '5410'])
    // BAS-vs-custom marker drives the dialog's default selection.
    expect(body.data.deletable.find((a) => a.account_number === '5410')?.in_bas_reference).toBe(true)
    expect(body.data.deletable.find((a) => a.account_number === '19301')?.in_bas_reference).toBe(false)
    // Used + system accounts land in the informational remainder.
    const usedNumbers = body.data.used.map((a) => a.account_number)
    expect(usedNumbers).toContain('1930')
    expect(usedNumbers).toContain('3001')
    expect(body.data.used.find((a) => a.account_number === '3001')?.usage_count).toBe(4)
  })

  it('execute deletes only re-verified unused accounts and skips the rest', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: chartAccounts },
      { data: usageRows },
      { data: null }, // delete chunk
    ])
    auth(supabase)

    // Client asks for a used account (3001), a system account (1930), an
    // unknown number (9999) and two legitimately deletable ones.
    const req = createMockRequest('/api/bookkeeping/accounts/prune', {
      method: 'POST',
      body: { dry_run: false, account_numbers: ['3001', '1930', '9999', '5410', '19301'] },
    })
    const { status, body } = await parseJsonResponse<{
      data: { deleted: string[]; skipped: string[]; not_found: string[] }
    }>(await prunePOST(req, routeParams))

    expect(status).toBe(200)
    expect(body.data.deleted.sort()).toEqual(['19301', '5410'])
    expect(body.data.skipped.sort()).toEqual(['1930', '3001'])
    expect(body.data.not_found).toEqual(['9999'])

    // The DELETE is company-scoped, guards system accounts, and only carries
    // the re-verified numbers.
    const inCalls = calls.filter((c) => c.method === 'in').map((c) => c.args)
    expect(inCalls).toContainEqual(['account_number', ['5410', '19301']])
    const eqCalls = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqCalls).toContainEqual(['is_system_account', false])
  })

  it('execute with nothing deletable deletes nothing and reports the skips', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: chartAccounts },
      { data: usageRows },
    ])
    auth(supabase)

    const req = createMockRequest('/api/bookkeeping/accounts/prune', {
      method: 'POST',
      body: { dry_run: false, account_numbers: ['3001'] },
    })
    const { status, body } = await parseJsonResponse<{
      data: { deleted: string[]; skipped: string[] }
    }>(await prunePOST(req, routeParams))

    expect(status).toBe(200)
    expect(body.data.deleted).toEqual([])
    expect(body.data.skipped).toEqual(['3001'])
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(0)
  })

  it('returns 403 when the member lacks write permission', async () => {
    const { supabase } = createCapturingSupabase([])
    auth(supabase)
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const req = createMockRequest('/api/bookkeeping/accounts/prune', {
      method: 'POST',
      body: { dry_run: true },
    })
    const res = await prunePOST(req, routeParams)
    expect(res.status).toBe(403)
  })
})
