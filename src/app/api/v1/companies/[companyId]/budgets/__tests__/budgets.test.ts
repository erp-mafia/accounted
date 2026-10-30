/**
 * Budgets through the v1 door of the operation registry
 * (src/lib/operations/budgets.ts over lib/budgets/service.ts):
 *   GET/POST          /api/v1/companies/:companyId/budgets
 *   GET/PATCH/DELETE  /api/v1/companies/:companyId/budgets/:id
 *   POST              /api/v1/companies/:companyId/budgets/:id/lines
 *   POST              /api/v1/companies/:companyId/budgets/:id/copy-actuals
 *   POST              /api/v1/companies/:companyId/budgets/:id/spread
 *   GET               /api/v1/companies/:companyId/reports/budget-vs-actual
 *
 * The database rules (months inside the year, accounts in the kontoplan,
 * one default per year, the atomic save) are pinned in
 * tests/pg/budgets.pg.test.ts; here: auth, validation, the company scoping
 * of every read, and what the service hands the RPCs.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
// Report reads take the SIE period lease (lib/import/sie-period-read.ts); not the subject here.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _op: unknown, read: () => unknown) => read(),
}))
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { GET as listBudgets, POST as createBudget } from '../route'
import { GET as getBudget, PATCH as updateBudget, DELETE as deleteBudget } from '../[id]/route'
import { POST as upsertLines } from '../[id]/lines/route'
import { POST as copyActuals } from '../[id]/copy-actuals/route'
import { POST as spread } from '../[id]/spread/route'
import { GET as budgetVsActual } from '../../reports/budget-vs-actual/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

/**
 * The shared per-table mock (tests/helpers.ts); an rpc answers under
 * 'rpc:<name>'. The client itself carries the recorded calls.
 */
function makeClient(byTable: Record<string, TableMockResult | TableMockResult[]>) {
  const mock = createTableMockSupabase(byTable)
  return Object.assign(mock.supabase, { calls: mock.calls, findCall: mock.findCall })
}

const rpcArgs = (client: ReturnType<typeof makeClient>, name: string) => client.findCall(`rpc:${name}`, 'rpc')?.[0]
const calledRpc = (client: ReturnType<typeof makeClient>, prefix: string) =>
  client.calls.some((c) => c.table.startsWith(`rpc:${prefix}`))

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PREVIOUS_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const BUDGET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}`

const BUDGET_ROW = {
  id: BUDGET_ID,
  fiscal_period_id: PERIOD_ID,
  name: 'Budget 2027',
  is_default: true,
  archived_at: null,
  created_at: '2026-11-02T09:00:00Z',
  updated_at: '2026-11-02T09:00:00Z',
}
const PERIOD_ROW = { id: PERIOD_ID, name: '2027', period_start: '2027-01-01', period_end: '2027-12-31', previous_period_id: PREVIOUS_ID }
const PREVIOUS_ROW = { id: PREVIOUS_ID, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null }
const SAVED = { ok: true, budget_id: BUDGET_ID, inserted: 12, updated: 0, deleted: 0, unchanged: 0 }

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const budgetParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: BUDGET_ID }) }
const post = (url: string, body: unknown) => request(url, { method: 'POST', body: JSON.stringify(body) })

function eqFilters(calls: Array<{ table: string; method: string; args: unknown[] }>, table: string) {
  return calls.filter((c) => c.table === table && c.method === 'eq').map((c) => c.args)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read', 'bookkeeping:write'],
    mode: 'live',
  })
})

describe('GET /budgets', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    const res = await listBudgets(request(`${BASE}/budgets`), companyParams)
    expect(res.status).toBe(401)
  })

  it('400 for a fiscal year filter that is not an id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await listBudgets(request(`${BASE}/budgets?fiscal_period_id=2027`), companyParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('200 with the company\'s budgets, archived ones left out', async () => {
    const client = makeClient({ company_members: MEMBER, budgets: { data: [BUDGET_ROW], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await listBudgets(request(`${BASE}/budgets?fiscal_period_id=${PERIOD_ID}`), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.budgets).toEqual([
      {
        budget_id: BUDGET_ID,
        fiscal_period_id: PERIOD_ID,
        name: 'Budget 2027',
        is_default: true,
        archived: false,
        archived_at: null,
        created_at: BUDGET_ROW.created_at,
        updated_at: BUDGET_ROW.updated_at,
      },
    ])
    expect(eqFilters(client.calls, 'budgets')).toEqual([
      ['company_id', COMPANY_ID],
      ['fiscal_period_id', PERIOD_ID],
    ])
    expect(client.calls.some((c) => c.table === 'budgets' && c.method === 'is' && c.args[0] === 'archived_at')).toBe(true)
  })
})

describe('POST /budgets', () => {
  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await createBudget(post(`${BASE}/budgets`, { fiscal_period_id: PERIOD_ID, name: 'Budget 2027' }), companyParams)
    expect(res.status).toBe(403)
  })

  it('400 without a name', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await createBudget(post(`${BASE}/budgets`, { fiscal_period_id: PERIOD_ID, name: '  ' }), companyParams)
    expect(res.status).toBe(400)
  })

  it('404 PERIOD_NOT_FOUND for a fiscal year the company does not have', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, fiscal_periods: { data: null, error: null } }))
    const res = await createBudget(post(`${BASE}/budgets`, { fiscal_period_id: PERIOD_ID, name: 'Budget 2027' }), companyParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('PERIOD_NOT_FOUND')
  })

  it('409 BUDGET_NAME_TAKEN for a name the year has, case ignored', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        fiscal_periods: { data: PERIOD_ROW, error: null },
        budgets: { data: [{ id: BUDGET_ID, name: 'budget 2027' }], error: null },
      }),
    )
    const res = await createBudget(post(`${BASE}/budgets`, { fiscal_period_id: PERIOD_ID, name: 'Budget 2027' }), companyParams)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('BUDGET_NAME_TAKEN')
  })

  it('201: the year\'s first budget becomes its default', async () => {
    const client = makeClient({
      company_members: MEMBER,
      fiscal_periods: { data: PERIOD_ROW, error: null },
      budgets: [
        { data: [], error: null }, // the name rule
        { data: [], error: null }, // no default yet
        { data: BUDGET_ROW, error: null }, // the insert
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await createBudget(post(`${BASE}/budgets`, { fiscal_period_id: PERIOD_ID, name: ' Budget 2027 ' }), companyParams)
    expect(res.status).toBe(201)
    expect((await res.json()).data.budget).toMatchObject({ budget_id: BUDGET_ID, is_default: true })
    const insert = client.calls.find((c) => c.table === 'budgets' && c.method === 'insert')
    expect(insert?.args[0]).toEqual({
      company_id: COMPANY_ID,
      user_id: 'user-1',
      fiscal_period_id: PERIOD_ID,
      name: 'Budget 2027',
      is_default: true,
    })
  })
})

describe('GET /budgets/:id', () => {
  it('404 BUDGET_NOT_FOUND for a budget of another company', async () => {
    const client = makeClient({ company_members: MEMBER, budgets: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await getBudget(request(`${BASE}/budgets/${BUDGET_ID}`), budgetParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('BUDGET_NOT_FOUND')
    expect(eqFilters(client.calls, 'budgets')).toEqual([
      ['company_id', COMPANY_ID],
      ['id', BUDGET_ID],
    ])
  })

  it('400 for a page larger than PostgREST answers (1000 lines)', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await getBudget(request(`${BASE}/budgets/${BUDGET_ID}?limit=5000`), budgetParams)
    expect(res.status).toBe(400)
  })

  it('200 with its lines in months, paged', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        budgets: { data: BUDGET_ROW, error: null },
        budget_lines: {
          data: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', account_number: '3010', month: '2027-01-01', dimensions: {}, amount: '-100000.00' }],
          error: null,
          count: 3,
        },
      }),
    )
    const res = await getBudget(request(`${BASE}/budgets/${BUDGET_ID}?limit=1`), budgetParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.lines).toEqual([
      { budget_line_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', account_number: '3010', month: '2027-01', dimensions: {}, amount: -100000 },
    ])
    expect(body.data).toMatchObject({ total_lines: 3, has_more: true })
  })
})

describe('PATCH /budgets/:id', () => {
  const patch = (body: unknown) =>
    updateBudget(request(`${BASE}/budgets/${BUDGET_ID}`, { method: 'PATCH', body: JSON.stringify(body) }), budgetParams)

  it('400 when nothing is sent', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await patch({})
    expect(res.status).toBe(400)
  })

  it('409 BUDGET_ARCHIVED when an archived budget is made the default', async () => {
    const client = makeClient({ company_members: MEMBER, budgets: { data: { ...BUDGET_ROW, is_default: false, archived_at: '2026-12-01T00:00:00Z' }, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ is_default: true })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('BUDGET_ARCHIVED')
    expect(client.calls.some((c) => c.method === 'update')).toBe(false)
  })

  it('200 archives it and takes the default away in the same write', async () => {
    const client = makeClient({
      company_members: MEMBER,
      budgets: [
        { data: BUDGET_ROW, error: null },
        { data: { ...BUDGET_ROW, is_default: false, archived_at: '2026-12-01T00:00:00Z' }, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ archived: true })
    expect(res.status).toBe(200)
    expect((await res.json()).data.budget).toMatchObject({ archived: true, is_default: false })
    const update = client.calls.find((c) => c.table === 'budgets' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({ is_default: false, archived_at: expect.any(String) })
  })
})

describe('DELETE /budgets/:id', () => {
  it('404 when the budget is not the company\'s', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, budgets: { data: null, error: null } }))
    const res = await deleteBudget(request(`${BASE}/budgets/${BUDGET_ID}`, { method: 'DELETE' }), budgetParams)
    expect(res.status).toBe(404)
  })

  it('200 deletes it, scoped to the company', async () => {
    const client = makeClient({ company_members: MEMBER, budgets: { data: BUDGET_ROW, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await deleteBudget(request(`${BASE}/budgets/${BUDGET_ID}`, { method: 'DELETE' }), budgetParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ deleted: true, budget_id: BUDGET_ID })
    expect(client.calls.some((c) => c.table === 'budgets' && c.method === 'delete')).toBe(true)
  })
})

describe('POST /budgets/:id/lines', () => {
  const save = (body: unknown) => upsertLines(post(`${BASE}/budgets/${BUDGET_ID}/lines`, body), budgetParams)

  it('400 for a balance sheet account or a month that is not YYYY-MM, nothing saved', async () => {
    const client = makeClient({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(client)
    expect((await save({ lines: [{ account_number: '1930', month: '2027-01', amount: 100 }] })).status).toBe(400)
    expect((await save({ lines: [{ account_number: '3010', month: '2027-1', amount: 100 }] })).status).toBe(400)
    expect((await save({ lines: [{ account_number: 3010, month: '2027-01', amount: 100 }] })).status).toBe(400)
    expect(calledRpc(client, 'upsert_budget_lines')).toBe(false)
  })

  it('404 BUDGET_NOT_FOUND before the RPC sees a budget of another company', async () => {
    const client = makeClient({ company_members: MEMBER, budgets: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await save({ lines: [{ account_number: '3010', month: '2027-01', amount: -100 }] })
    expect(res.status).toBe(404)
    expect(calledRpc(client, 'upsert_budget_lines')).toBe(false)
  })

  it('404 BUDGET_ACCOUNT_NOT_FOUND with the accounts the kontoplan lacks', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        budgets: { data: BUDGET_ROW, error: null },
        'rpc:upsert_budget_lines': { data: { ok: false, code: 'BUDGET_ACCOUNT_NOT_FOUND', account_numbers: ['3999'] }, error: null },
      }),
    )
    const res = await save({ lines: [{ account_number: '3999', month: '2027-01', amount: -100 }] })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('BUDGET_ACCOUNT_NOT_FOUND')
    expect(body.error.details).toMatchObject({ account_numbers: ['3999'] })
  })

  it('200 saves through the atomic RPC: first day of the month, öre, {} for no tag', async () => {
    const client = makeClient({
      company_members: MEMBER,
      budgets: { data: BUDGET_ROW, error: null },
      'rpc:upsert_budget_lines': { data: { ...SAVED, inserted: 2 }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await save({
      lines: [
        { account_number: '3010', month: '2027-01', amount: -100000.004 },
        { account_number: '5010', month: '2027-02', dimensions: { '6': 'P001' }, amount: 0 },
      ],
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ budget_id: BUDGET_ID, inserted: 2, updated: 0, deleted: 0, unchanged: 0 })
    expect(rpcArgs(client, 'upsert_budget_lines')).toEqual({
      p_budget_id: BUDGET_ID,
      p_lines: [
        { account_number: '3010', month: '2027-01-01', dimensions: {}, amount: -100000 },
        { account_number: '5010', month: '2027-02-01', dimensions: { '6': 'P001' }, amount: 0 },
      ],
    })
  })
})

describe('POST /budgets/:id/copy-actuals', () => {
  it('404 BUDGET_SOURCE_YEAR_NOT_FOUND without a previous year', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        budgets: { data: BUDGET_ROW, error: null },
        fiscal_periods: [{ data: { ...PERIOD_ROW, previous_period_id: null }, error: null }, { data: null, error: null }],
      }),
    )
    const res = await copyActuals(post(`${BASE}/budgets/${BUDGET_ID}/copy-actuals`, {}), budgetParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('BUDGET_SOURCE_YEAR_NOT_FOUND')
  })

  it('200 copies last year month by month, scaled, every month of each copied account', async () => {
    const client = makeClient({
      company_members: MEMBER,
      budgets: { data: BUDGET_ROW, error: null },
      fiscal_periods: [{ data: PERIOD_ROW, error: null }, { data: PREVIOUS_ROW, error: null }],
      'rpc:get_account_month_actuals': { data: [{ account_number: '3010', month: '2026-03-01', amount: -1000 }], error: null },
      'rpc:upsert_budget_lines': { data: SAVED, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await copyActuals(post(`${BASE}/budgets/${BUDGET_ID}/copy-actuals`, { percent_change: 10 }), budgetParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ source_fiscal_period_id: PREVIOUS_ID, accounts: ['3010'], inserted: 12 })

    expect(rpcArgs(client, 'get_account_month_actuals')).toEqual({
      p_company_id: COMPANY_ID,
      p_fiscal_period_id: PREVIOUS_ID,
      p_from: null,
      p_to: null,
      p_dimensions: null,
    })
    const lines = (rpcArgs(client, 'upsert_budget_lines') as { p_lines: { month: string; amount: number }[] }).p_lines
    expect(lines).toHaveLength(12)
    expect(lines.find((l) => l.month === '2027-03-01')?.amount).toBe(-1100)
    expect(lines.find((l) => l.month === '2027-04-01')?.amount).toBe(0)
  })
})

describe('POST /budgets/:id/spread', () => {
  it('200 spreads evenly with the remainder in the last month', async () => {
    const client = makeClient({
      company_members: MEMBER,
      budgets: { data: BUDGET_ROW, error: null },
      fiscal_periods: { data: PERIOD_ROW, error: null },
      'rpc:upsert_budget_lines': { data: SAVED, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await spread(post(`${BASE}/budgets/${BUDGET_ID}/spread`, { account_number: '3010', amount: -100 }), budgetParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ method: 'even', fell_back_to_even: false, account_number: '3010' })
    expect(body.data.months[0]).toEqual({ month: '2027-01', amount: -8.33 })
    expect(body.data.months[11]).toEqual({ month: '2027-12', amount: -8.37 })
  })

  it('a dry run counts through the RPC and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      budgets: { data: BUDGET_ROW, error: null },
      fiscal_periods: { data: PERIOD_ROW, error: null },
      'rpc:upsert_budget_lines_preview': { data: SAVED, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await spread(post(`${BASE}/budgets/${BUDGET_ID}/spread?dry_run=true`, { account_number: '3010', amount: -1200 }), budgetParams)
    expect(res.status).toBe(200)
    // The STABLE preview only: the writer is never called on a dry run.
    expect(rpcArgs(client, 'upsert_budget_lines_preview')).toBeDefined()
    expect(rpcArgs(client, 'upsert_budget_lines')).toBeUndefined()
  })
})

describe('GET /reports/budget-vs-actual', () => {
  const report = (query: string) => budgetVsActual(request(`${BASE}/reports/budget-vs-actual?${query}`), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await report(`budget_id=${BUDGET_ID}`)).status).toBe(401)
  })

  it('400 without a budget or a fiscal year, and for half a dimension filter', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await report('from_month=2027-01')).status).toBe(400)
    expect((await report(`budget_id=${BUDGET_ID}&dim_no=6`)).status).toBe(400)
  })

  it('404 BUDGET_NONE_FOR_YEAR when the year has no default budget', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, fiscal_periods: { data: PERIOD_ROW, error: null }, budgets: { data: null, error: null } }),
    )
    const res = await report(`fiscal_period_id=${PERIOD_ID}`)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('BUDGET_NONE_FOR_YEAR')
  })

  it('400 BUDGET_MONTH_OUTSIDE_YEAR for a window outside the budget\'s year', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, budgets: { data: BUDGET_ROW, error: null }, fiscal_periods: { data: PERIOD_ROW, error: null } }),
    )
    const res = await report(`budget_id=${BUDGET_ID}&from_month=2026-12`)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('BUDGET_MONTH_OUTSIDE_YEAR')
  })

  it('200 compares whole months, filtered by one dimension value on both sides', async () => {
    const client = makeClient({
      company_members: MEMBER,
      budgets: { data: BUDGET_ROW, error: null },
      fiscal_periods: { data: PERIOD_ROW, error: null },
      'rpc:get_account_month_actuals': { data: [{ account_number: '3010', month: '2027-02-01', amount: -12000 }], error: null },
      budget_lines: { data: [{ account_number: '3010', month: '2027-02-01', amount: '-10000.00' }], error: null },
      chart_of_accounts: { data: [{ account_number: '3010', account_name: 'Försäljning' }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await report(`budget_id=${BUDGET_ID}&from_month=2027-01&to_month=2027-02&dim_no=6&dim_code=P001`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ from_month: '2027-01', to_month: '2027-02', months: ['2027-01', '2027-02'], dimension_filter: { '6': 'P001' } })
    expect(body.data.rows).toEqual([
      {
        account_number: '3010',
        account_name: 'Försäljning',
        months: [
          { month: '2027-01', budget: 0, actual: 0, deviation: 0, deviation_percent: null },
          { month: '2027-02', budget: 10000, actual: 12000, deviation: 2000, deviation_percent: 20 },
        ],
        total: { budget: 10000, actual: 12000, deviation: 2000, deviation_percent: 20 },
      },
    ])

    expect(rpcArgs(client, 'get_account_month_actuals')).toEqual({
      p_company_id: COMPANY_ID,
      p_fiscal_period_id: PERIOD_ID,
      p_from: '2027-01-01',
      p_to: '2027-02-28',
      p_dimensions: { '6': 'P001' },
    })
    const contains = client.calls.find((c) => c.table === 'budget_lines' && c.method === 'contains')
    expect(contains?.args).toEqual(['dimensions', { '6': 'P001' }])
  })
})
