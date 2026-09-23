/**
 * Tests for GET /api/v1/companies/{companyId}/employees/{id}/vacation-balance
 * (payroll gap-closure 3.4).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `vacation-balance route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
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
import { GET as getBalance } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

function makeFlexibleSupabase(byTable: Record<string, { data?: unknown; error?: unknown }>) {
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(byTable[table] ?? { data: null, error: null })
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BALANCE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const EMPLOYEE = {
  id: EMPLOYEE_ID,
  vacation_rule: 'sammaloneregeln',
  vacation_days_per_year: 25,
  salary_type: 'monthly',
  monthly_salary: 30000,
  hourly_rate: null,
  hours_per_week: 40,
  workdays_per_week: 5,
}

const BALANCE = {
  id: BALANCE_ID,
  employee_id: EMPLOYEE_ID,
  vacation_year_start: '2026-01-01',
  entitled_days: 25,
  accrued_days: 0,
  taken_days: 10,
  saved_days: { '2025': 5 },
  forced_payout_days: 0,
}

function makeRequest(url: string): Request {
  return new Request(url, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['payroll:read'],
    mode: 'live',
  })
})

describe('GET /employees/:id/vacation-balance', () => {
  it('returns the balance with remaining days and a SEK estimate', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: EMPLOYEE, error: null },
        employee_vacation_balances: { data: BALANCE, error: null },
      }),
    )

    const res = await getBalance(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/vacation-balance`,
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.employee_vacation_balance_id).toBe(BALANCE_ID)
    expect(body.data.remaining_days).toBe(15)
    expect(body.data.saved_days_total).toBe(5)
    // Day value sammalöneregeln: 30000/21 + 30000 x 0.0043 = 1557.57.
    // Liability = (15 remaining + 5 saved) x 1557.57 = 31151.4.
    expect(body.data.estimated_liability_sek).toBe(31151.4)
    expect(body.data.id).toBeUndefined()
  })

  it('returns 404 VACATION_BALANCE_NOT_FOUND before the ledger seeds', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: EMPLOYEE, error: null },
        employee_vacation_balances: { data: null, error: null },
      }),
    )

    const res = await getBalance(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/vacation-balance`,
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('VACATION_BALANCE_NOT_FOUND')
  })

  it('returns 404 EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: null, error: null },
      }),
    )
    const res = await getBalance(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/vacation-balance`,
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await getBalance(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/vacation-balance`,
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(401)
  })
})
