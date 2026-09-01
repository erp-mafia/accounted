/**
 * Integration tests for GET .../cash-accounts (bank/cash accounts with the
 * bank-reported balance).
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
vi.mock('@/lib/cash-accounts/service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cash-accounts/service')>('@/lib/cash-accounts/service')
  return { ...actual, listForCompany: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { listForCompany } from '@/lib/cash-accounts/service'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function getRequest(url: string, withAuth = true): Request {
  return new Request(url, {
    method: 'GET',
    headers: withAuth ? { Authorization: 'Bearer test-fixture-not-a-real-key' } : {},
  })
}

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
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

function makeMemberSupabase() {
  return makeFlexibleSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockServiceClient.mockReturnValue(makeMemberSupabase())
})

describe('GET /api/v1/companies/{companyId}/cash-accounts', () => {
  beforeEach(() => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      scopes: ['transactions:read'],
      mode: 'live',
    })
  })

  it('returns 401 without an API key', async () => {
    mockValidate.mockResolvedValue(null)
    const res = await GET(
      getRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/cash-accounts`, false),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 on an invalid enabled_only value', async () => {
    const res = await GET(
      getRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/cash-accounts?enabled_only=banana`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns the accounts with bank-reported balance fields', async () => {
    vi.mocked(listForCompany).mockResolvedValue([
      {
        id: 'ca-1',
        company_id: COMPANY_ID,
        ledger_account: '1930',
        name: 'Företagskonto',
        currency: 'SEK',
        iban: 'SE4550000000058398257466',
        is_primary: true,
        enabled: true,
        source: 'enable_banking',
        balance: 125430.5,
        available_balance: 123930.5,
        balance_updated_at: '2026-09-01T05:12:44.000Z',
      },
      {
        id: 'ca-2',
        company_id: COMPANY_ID,
        ledger_account: '1940',
        name: null,
        currency: 'SEK',
        iban: null,
        is_primary: false,
        enabled: true,
        source: 'manual',
      },
    ] as never)

    const res = await GET(
      getRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/cash-accounts`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.cash_accounts).toHaveLength(2)
    expect(body.data.cash_accounts[0]).toEqual({
      cash_account_id: 'ca-1',
      ledger_account: '1930',
      name: 'Företagskonto',
      currency: 'SEK',
      iban: 'SE4550000000058398257466',
      is_primary: true,
      enabled: true,
      source: 'enable_banking',
      balance: 125430.5,
      available_balance: 123930.5,
      balance_updated_at: '2026-09-01T05:12:44.000Z',
    })
    // Manual account: explicit nulls for the bank-reported fields.
    expect(body.data.cash_accounts[1]).toMatchObject({
      cash_account_id: 'ca-2',
      balance: null,
      available_balance: null,
      balance_updated_at: null,
    })
    // Qualified ids only: no bare `id` on the wire.
    expect(body.data.cash_accounts[0]).not.toHaveProperty('id')
  })

  it('passes enabled_only=true through to the service', async () => {
    vi.mocked(listForCompany).mockResolvedValue([])
    const res = await GET(
      getRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/cash-accounts?enabled_only=true`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    expect(listForCompany).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, { enabledOnly: true })
  })
})
