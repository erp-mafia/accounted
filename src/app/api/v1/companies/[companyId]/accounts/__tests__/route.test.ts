/**
 * Integration tests for GET /api/v1/companies/:companyId/accounts and
 * GET .../fiscal-periods.
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
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listAccounts } from '../route'
import { GET as listPeriods } from '../../fiscal-periods/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
type ChainCall = { table: string; method: string; args: unknown[] }
function makeFlexibleSupabase(
  byTable: Record<string, MockResult | MockResult[]>,
  calls: ChainCall[] = [],
) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (...args: unknown[]) => {
          calls.push({ table, method: String(prop), args })
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeRequest(url: string): Request {
  return new Request(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['reports:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/accounts', () => {
  it('returns active accounts by default', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        chart_of_accounts: {
          data: [
            {
              account_number: '1930',
              account_name: 'Företagskonto',
              account_class: 1,
              account_group: '19',
              account_type: 'asset',
              normal_balance: 'debit',
              is_system_account: true,
              is_active: true,
              description: null,
              default_vat_code: null,
              sru_code: null,
              sort_order: 1930,
            },
          ],
          error: null,
        },
      }),
    )
    const res = await listAccounts(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/accounts`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.accounts).toHaveLength(1)
    expect(body.data.accounts[0].account_number).toBe('1930')
  })

  it('returns all rows in account_number order when the chart exceeds the 1000-row PostgREST page', async () => {
    const makeAccount = (n: number, sortOrder: number | null = n) => ({
      account_number: String(n),
      account_name: `Konto ${n}`,
      account_class: Math.floor(n / 1000),
      account_group: String(n).slice(0, 2),
      account_type: 'asset',
      normal_balance: 'debit',
      is_system_account: false,
      is_active: true,
      description: null,
      default_vat_code: null,
      sru_code: null,
      sort_order: sortOrder,
    })
    // Page 1: exactly 1000 rows (forces a second range request). The pages
    // arrive in account_number order, as Postgres returns them. Accounts 1500
    // and 2100 carry sort_order 0, like every account seeded at company
    // creation, and 9998 a null one: none of them may move, because sort_order
    // is not the BAS sequence and re-sorting by it put the seeded block first.
    const page1 = Array.from({ length: 1000 }, (_, i) =>
      makeAccount(1000 + i, 1000 + i === 1500 ? 0 : 1000 + i),
    )
    const page2 = [
      ...Array.from({ length: 289 }, (_, i) => makeAccount(2000 + i, 2000 + i === 2100 ? 0 : 2000 + i)),
      makeAccount(9998, null),
    ]
    const calls: ChainCall[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          chart_of_accounts: [
            { data: page1, error: null },
            { data: page2, error: null },
          ],
        },
        calls,
      ),
    )
    const res = await listAccounts(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/accounts`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    const numbers = body.data.accounts.map((a: { account_number: string }) => a.account_number)
    expect(numbers).toHaveLength(1290)
    expect(numbers).toEqual([...page1, ...page2].map((a) => a.account_number))
    expect(numbers[500]).toBe('1500')
    expect(numbers[1100]).toBe('2100')
    expect(numbers[1289]).toBe('9998')
    const orderCalls = calls.filter((c) => c.table === 'chart_of_accounts' && c.method === 'order')
    expect(orderCalls.length).toBeGreaterThan(0)
    for (const call of orderCalls) {
      expect(call.args[0]).toBe('account_number')
    }
  })

  it('accepts class 9 and filters on account_class', async () => {
    const calls: ChainCall[] = []
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase(
        {
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          chart_of_accounts: { data: [], error: null },
        },
        calls,
      ),
    )
    const res = await listAccounts(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/accounts?class=9`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    expect(calls).toContainEqual({ table: 'chart_of_accounts', method: 'eq', args: ['account_class', 9] })
  })

  it('rejects invalid class filter', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await listAccounts(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/accounts?class=10`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
  })

  it('rejects keys without reports:read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await listAccounts(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/accounts`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /api/v1/companies/:companyId/fiscal-periods', () => {
  it('returns fiscal periods sorted by period_start desc', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        fiscal_periods: {
          data: [
            {
              id: 'fp-1',
              name: 'Räkenskapsår 2026',
              period_start: '2026-01-01',
              period_end: '2026-12-31',
              is_closed: false,
              closed_at: null,
              locked_at: null,
              previous_period_id: null,
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
          error: null,
        },
      }),
    )
    const res = await listPeriods(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/fiscal-periods`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.fiscal_periods).toHaveLength(1)
    // Phase 3 review fix: derived BFL 3 kap fields appear on every row.
    expect(body.data.fiscal_periods[0].duration_days).toBe(365) // 2026-01-01 → 2026-12-31
    expect(body.data.fiscal_periods[0].exceeds_18_months).toBe(false)
  })
})
