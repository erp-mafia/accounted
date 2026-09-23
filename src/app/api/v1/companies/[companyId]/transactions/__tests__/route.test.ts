/**
 * Integration tests for GET /api/v1/companies/:companyId/transactions
 * (list) and GET .../:id (detail).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`tx route tests require NODE_ENV=test`)
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listTransactions } from '../route'
import { GET as getTransaction } from '../[id]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
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
const calls: Array<{ table: string; method: string; args: unknown[] }> = []

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

function makeRequest(url: string): Request {
  return new Request(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/transactions', () => {
  it('returns a list with pagination metadata', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: [
            { id: TX_ID, date: '2026-05-12', amount: -100, currency: 'SEK', description: 'ICA' },
          ],
          error: null,
        },
      }),
    )

    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    // No next page → omitted (paginated() helper drops the key entirely
    // when nextCursor is undefined).
    expect(body.meta.next_cursor).toBeUndefined()
  })

  it('passes cash_account_id through as a filter and returns it on each row', async () => {
    const CASH_ACCOUNT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: [
          {
            id: TX_ID, date: '2026-05-12', amount: -100, currency: 'SEK', description: 'ICA',
            cash_account_id: CASH_ACCOUNT_ID, created_at: '2026-05-12T10:00:00Z',
          },
        ],
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions?cash_account_id=${CASH_ACCOUNT_ID}`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data[0].cash_account_id).toBe(CASH_ACCOUNT_ID)
    const eqCalls = calls.filter((c) => c.table === 'transactions' && c.method === 'eq' && c.args[0] === 'cash_account_id')
    expect(eqCalls.map((c) => c.args[1])).toEqual([CASH_ACCOUNT_ID])
  })

  it('rejects a non-UUID cash_account_id filter with 400', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: [], error: null },
      }),
    )
    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions?cash_account_id=1930`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
  })

  it('rejects invalid status filter with 400', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await listTransactions(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions?status=unknown`,
      ),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
  })

  it('rejects keys without transactions:read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /api/v1/companies/:companyId/transactions/:id', () => {
  it('returns 200 with the transaction', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: { id: TX_ID, date: '2026-05-12', amount: -100, currency: 'SEK' },
          error: null,
        },
      }),
    )
    const res = await getTransaction(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}`),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) },
    )
    expect(res.status).toBe(200)
  })

  it('returns 404 NOT_FOUND for unknown id', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: null, error: null },
      }),
    )
    const res = await getTransaction(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}`),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) },
    )
    expect(res.status).toBe(404)
  })

  it('rejects non-UUID id with 400', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await getTransaction(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/not-a-uuid`),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: 'not-a-uuid' }) },
    )
    expect(res.status).toBe(400)
  })
})
