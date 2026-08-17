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

/** Chainable builder recording calls; resolves queued {data,error,count} per from()/rpc(). */
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
    rpc: (...args: unknown[]) => {
      calls.push({ method: 'rpc', args })
      const result = results[idx++] ?? { data: null, error: null, count: null }
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null })
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

  it('lists accounts via the single-round-trip RPC', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: [{ account_number: '1930', account_name: 'Företagskonto' }] },
    ])
    auth(supabase)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(
      await listGET(createMockRequest('/api/bookkeeping/accounts'), routeParams)
    )
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    const rpcCall = calls.find((c) => c.method === 'rpc')
    expect(rpcCall?.args).toEqual([
      'list_company_accounts',
      { p_company_id: 'company-1', p_active_only: true, p_account_class: null },
    ])
    // The RPC path must not also hit the table: exactly one round trip.
    expect(calls.some((c) => c.method === 'from')).toBe(false)
  })

  it('maps ?class=3&active=false onto the RPC arguments', async () => {
    const { supabase, calls } = createCapturingSupabase([{ data: [] }])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts', {
      searchParams: { class: '3', active: 'false' },
    })
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(
      await listGET(req, routeParams)
    )
    expect(status).toBe(200)
    expect(body.data).toEqual([])
    const rpcCall = calls.find((c) => c.method === 'rpc')
    expect(rpcCall?.args[1]).toEqual({
      p_company_id: 'company-1',
      p_active_only: false,
      p_account_class: 3,
    })
  })

  it('falls back to the paged fetch when the RPC is not deployed (PGRST202)', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { error: { code: 'PGRST202', message: 'function not found in schema cache' } },
      { data: [{ account_number: '1930', account_name: 'Företagskonto' }] },
    ])
    auth(supabase)
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(
      await listGET(createMockRequest('/api/bookkeeping/accounts'), routeParams)
    )
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'from').map((c) => c.args)).toContainEqual([
      'chart_of_accounts',
    ])
    expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toContainEqual([
      'company_id',
      'company-1',
    ])
  })

  it('returns the legacy 500 { error: string } on a non-fallback RPC error', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { error: { code: 'XX000', message: 'boom' } },
    ])
    auth(supabase)
    const { status, body } = await parseJsonResponse<{ error: string }>(
      await listGET(createMockRequest('/api/bookkeeping/accounts'), routeParams)
    )
    expect(status).toBe(500)
    expect(typeof body.error).toBe('string')
    // A non-deploy error must NOT silently fall back to the paged fetch.
    expect(calls.some((c) => c.method === 'from')).toBe(false)
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

  it('keeps the plain 409 when the colliding account is active', async () => {
    const { supabase } = createCapturingSupabase([
      { error: { code: '23505', message: 'dup' } },
      { data: { is_active: true } },
    ])
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
    expect(typeof body.error).toBe('string')
  })

  it('returns ACCOUNT_EXISTS_INACTIVE when the colliding account is deactivated', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { error: { code: '23505', message: 'dup' } },
      { data: { is_active: false } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts', {
      method: 'POST',
      body: {
        account_number: '3910',
        account_name: 'Hyresintäkter egen',
        account_type: 'revenue',
        normal_balance: 'credit',
      },
    })
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details?: { account_number?: string } }
    }>(await createPOST(req, routeParams))

    expect(status).toBe(409)
    expect(body.error.code).toBe('ACCOUNT_EXISTS_INACTIVE')
    expect(body.error.message).toContain('3910')
    expect(body.error.details?.account_number).toBe('3910')
    // The is_active lookup must be company-scoped, not a bare account_number
    // match: the same number exists under every other company too.
    const eqArgs = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqArgs).toContainEqual(['company_id', 'company-1'])
    expect(eqArgs).toContainEqual(['account_number', '3910'])
  })

  it('forwards default_vat_rate into the insert', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { account_number: '3740', default_vat_rate: 0 } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts', {
      method: 'POST',
      body: {
        account_number: '3740',
        account_name: 'Öres- och kronutjämning',
        account_type: 'revenue',
        normal_balance: 'debit',
        default_vat_rate: 0,
      },
    })
    const { status } = await parseJsonResponse(await createPOST(req, routeParams))
    expect(status).toBe(200)
    const insertArg = calls.find((c) => c.method === 'insert')?.args[0] as {
      default_vat_rate?: number | null
    }
    expect(insertArg?.default_vat_rate).toBe(0)
  })

  it('forwards default_vat_treatment into the insert', async () => {
    const { supabase, calls } = createCapturingSupabase([{
      data: { account_number: '4056', default_vat_treatment: 'reverse_charge_eu_goods' },
    }])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts', {
      method: 'POST',
      body: {
        account_number: '4056',
        account_name: 'Inköp varor EU',
        account_type: 'expense',
        normal_balance: 'debit',
        default_vat_treatment: 'reverse_charge_eu_goods',
      },
    })
    expect((await createPOST(req, routeParams)).status).toBe(200)
    const insertArg = calls.find((c) => c.method === 'insert')?.args[0] as {
      default_vat_treatment?: string | null
    }
    expect(insertArg.default_vat_treatment).toBe('reverse_charge_eu_goods')
  })

  it('derives the booking rate when a treatment is set without one', async () => {
    const { supabase, calls } = createCapturingSupabase([{ data: { account_number: '4056' } }])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts', {
      method: 'POST',
      body: {
        account_number: '4056',
        account_name: 'Inköp varor EU',
        account_type: 'expense',
        normal_balance: 'debit',
        default_vat_treatment: 'reverse_charge_eu_goods',
      },
    })
    expect((await createPOST(req, routeParams)).status).toBe(200)
    const insertArg = calls.find((c) => c.method === 'insert')?.args[0] as {
      default_vat_rate?: number | null
    }
    expect(insertArg.default_vat_rate).toBe(0.25)
  })

  it('rejects a treatment that cannot apply to the account class', async () => {
    const { supabase } = createCapturingSupabase([])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts', {
      method: 'POST',
      body: {
        account_number: '4056',
        account_name: 'Inköp varor EU',
        account_type: 'expense',
        normal_balance: 'debit',
        default_vat_treatment: 'standard_25',
      },
    })
    expect((await createPOST(req, routeParams)).status).toBe(400)
  })
})

describe('DELETE /api/bookkeeping/accounts/[number]', () => {
  it('scopes the usage check to the company via the usage-counts RPC', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { id: 'acc-1', is_system_account: false } }, // account fetch
      { data: [{ account_number: '4010', usage_count: 7 }] }, // usage counts (not 5010)
      { data: null }, // delete
    ])
    auth(supabase)

    const { status } = await parseJsonResponse(
      await DELETE(createMockRequest('/api/bookkeeping/accounts/5010'), numberParams)
    )

    expect(status).toBe(200)
    // The company scope is an RPC argument now, not a filter on an embed:
    // another company's use of the same BAS number can never be counted here.
    const rpcCalls = calls.filter((c) => c.method === 'rpc').map((c) => c.args)
    expect(rpcCalls).toContainEqual(['get_account_usage_counts', { p_company_id: 'company-1' }])
    const selectArgs = calls.filter((c) => c.method === 'select').map((c) => c.args[0])
    expect(selectArgs).not.toContain('id, journal_entries!inner(company_id)')
  })

  it('refuses deleting an account used in this company with 400', async () => {
    const { supabase } = createCapturingSupabase([
      { data: { id: 'acc-1', is_system_account: false } },
      { data: [{ account_number: '5010', usage_count: 3 }] },
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

  it('forwards default_vat_rate into the update', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { account_number: '3740', default_vat_rate: 0 } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/3740', {
      method: 'PUT',
      body: { default_vat_rate: 0 },
    })
    const { status } = await parseJsonResponse(
      await PUT(req, { params: Promise.resolve({ number: '3740' }) })
    )
    expect(status).toBe(200)
    const updateArg = calls.find((c) => c.method === 'update')?.args[0] as {
      default_vat_rate?: number | null
    }
    expect(updateArg?.default_vat_rate).toBe(0)
  })

  it('preserves an existing booking rate when updating only the treatment', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { default_vat_rate: 0.12 } },
      { data: { account_number: '3041', default_vat_treatment: 'standard_25' } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/3041', {
      method: 'PUT',
      body: { default_vat_treatment: 'standard_25' },
    })
    expect((await PUT(req, { params: Promise.resolve({ number: '3041' }) })).status).toBe(200)
    const updateArg = calls.find((c) => c.method === 'update')?.args[0] as {
      default_vat_treatment?: string | null
      default_vat_rate?: number | null
    }
    expect(updateArg.default_vat_treatment).toBe('standard_25')
    expect(updateArg.default_vat_rate).toBeUndefined()
  })

  it('derives the booking rate when treatment is updated and the stored rate is unset', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { default_vat_rate: null } },
      {
        data: {
          account_number: '4056',
          default_vat_treatment: 'reverse_charge_eu_goods',
          default_vat_rate: 0.25,
        },
      },
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/4056', {
      method: 'PUT',
      body: { default_vat_treatment: 'reverse_charge_eu_goods' },
    })

    expect((await PUT(req, { params: Promise.resolve({ number: '4056' }) })).status).toBe(200)
    const updateArg = calls.find((c) => c.method === 'update')?.args[0] as {
      default_vat_rate?: number | null
    }
    expect(updateArg.default_vat_rate).toBe(0.25)
  })

  // The body is spread straight into .update(), so the write set must be
  // exactly what the caller named. UpdateAccountSchema carries no .default()
  // today; these two lock the property in so adding one cannot turn a rename
  // into a silent rewrite of the VAT code and SRU mapping.
  it('writes only the field the caller named', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { account_number: '5010', account_name: 'Nytt namn' } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/5010', {
      method: 'PUT',
      body: { account_name: 'Nytt namn' },
    })
    expect((await parseJsonResponse(await PUT(req, numberParams))).status).toBe(200)

    const updateArg = calls.find((c) => c.method === 'update')?.args[0] as Record<string, unknown>
    expect(Object.keys(updateArg)).toEqual(['account_name'])
  })

  it('keeps an explicit null so sru_code can be cleared', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { account_number: '5010', sru_code: null } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/5010', {
      method: 'PUT',
      body: { sru_code: null },
    })
    expect((await parseJsonResponse(await PUT(req, numberParams))).status).toBe(200)

    const updateArg = calls.find((c) => c.method === 'update')?.args[0] as Record<string, unknown>
    expect(updateArg).toEqual({ sru_code: null })
  })

  it('drops unknown keys instead of forwarding them to the update', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: { account_number: '5010' } },
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/5010', {
      method: 'PUT',
      body: { account_name: 'Nytt namn', is_system_account: true, company_id: 'other' },
    })
    expect((await parseJsonResponse(await PUT(req, numberParams))).status).toBe(200)

    const updateArg = calls.find((c) => c.method === 'update')?.args[0] as Record<string, unknown>
    expect(Object.keys(updateArg)).toEqual(['account_name'])
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

  // The only route back for a deactivated account: it is in the chart, so the
  // insert path would hit the unique constraint. It must be flipped back on
  // instead, including for custom numbers the BAS reference has never heard of.
  it('reactivates an existing inactive account instead of inserting it', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: [{ account_number: '3910', is_active: false }] }, // existing lookup
      { data: [{ account_number: '3910' }] }, // update result
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/activate', {
      method: 'POST',
      body: { account_numbers: ['3910'] },
    })
    const { status, body } = await parseJsonResponse<{
      activated: number
      reactivated: number
      skipped: number
      unknown: string[]
    }>(await activatePOST(req, routeParams))

    expect(status).toBe(200)
    expect(body.reactivated).toBe(1)
    expect(body.activated).toBe(0)
    expect(body.unknown).toEqual([])
    expect(calls.find((c) => c.method === 'update')?.args[0]).toEqual({ is_active: true })
    expect(calls.some((c) => c.method === 'insert')).toBe(false)
  })

  it('skips an account that is already active', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: [{ account_number: '1930', is_active: true }] },
    ])
    auth(supabase)
    const req = createMockRequest('/api/bookkeeping/accounts/activate', {
      method: 'POST',
      body: { account_numbers: ['1930'] },
    })
    const { status, body } = await parseJsonResponse<{
      activated: number
      reactivated: number
      skipped: number
    }>(await activatePOST(req, routeParams))

    expect(status).toBe(200)
    expect(body.skipped).toBe(1)
    expect(body.reactivated).toBe(0)
    expect(calls.some((c) => c.method === 'update')).toBe(false)
    expect(calls.some((c) => c.method === 'insert')).toBe(false)
  })
})
