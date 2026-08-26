/**
 * Tests for the v1 opening-balances endpoints (payroll gap-closure 2.3):
 * GET/PUT /employees/{id}/opening-balances + bulk PUT /employees/opening-balances.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `opening-balances route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
import { GET as getBalances, PUT as putBalances } from '../route'
import { PUT as putBulk } from '../../../opening-balances/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const tableCalls: string[] = []
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
  return {
    tableCalls,
    from: vi.fn((table: string) => {
      tableCalls.push(table)
      return buildChain(table)
    }),
  }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ROW_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RUN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const USER_ID = 'user-1'

const CURRENT_YEAR = new Date().getFullYear()
const CUTOVER_DATE = `${CURRENT_YEAR}-07-01`

const SAMPLE_ROW = {
  id: ROW_ID,
  employee_id: EMPLOYEE_ID,
  cutover_date: CUTOVER_DATE,
  ytd_gross: 210000,
  ytd_tax: 48000,
  ytd_net: 162000,
  vacation_paid_days_remaining: 12.5,
  vacation_days_taken_this_year: 2,
  vacation_saved_days_by_year: { [`${CURRENT_YEAR - 1}`]: 5 },
  opening_semester_liability: 42000,
  opening_semester_liability_avgifter: 13196.4,
  karens_periods_adjustment: 1,
  created_at: '2026-07-01T08:00:00Z',
  updated_at: '2026-07-01T08:00:00Z',
}

const VALID_BODY = {
  cutover_date: CUTOVER_DATE,
  ytd_gross: 210000,
  ytd_tax: 48000,
  ytd_net: 162000,
  vacation_paid_days_remaining: 12.5,
  vacation_days_taken_this_year: 2,
  vacation_saved_days_by_year: { [`${CURRENT_YEAR - 1}`]: 5 },
  opening_semester_liability: 42000,
  opening_semester_liability_avgifter: 13196.4,
  karens_periods_adjustment: 1,
}

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      ...(init?.headers ?? {}),
    },
  })
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['payroll:read', 'payroll:write'],
    mode: 'live',
  })
})

describe('GET /employees/:id/opening-balances', () => {
  it('returns the row with lock state (happy path, unlocked)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        employee_opening_balances: { data: SAMPLE_ROW, error: null },
        salary_run_employees: { data: [], error: null },
      }),
    )

    const res = await getBalances(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.employee_opening_balances_id).toBe(ROW_ID)
    expect(body.data.ytd_gross).toBe(210000)
    expect(body.data.locked).toBe(false)
    expect(body.data.locked_by_run_id).toBeNull()
    expect(body.data.id).toBeUndefined()
  })

  it('reports locked with the blocking run id', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        employee_opening_balances: { data: SAMPLE_ROW, error: null },
        salary_run_employees: {
          data: [{ employee_id: EMPLOYEE_ID, salary_run: { id: RUN_ID, status: 'booked' } }],
          error: null,
        },
      }),
    )

    const res = await getBalances(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.locked).toBe(true)
    expect(body.data.locked_by_run_id).toBe(RUN_ID)
  })

  it('returns 404 when no balances are set', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        employee_opening_balances: { data: null, error: null },
      }),
    )
    const res = await getBalances(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: null, error: null },
      }),
    )
    const res = await getBalances(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })
})

describe('PUT /employees/:id/opening-balances', () => {
  it('upserts and returns the row (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: {
          data: [{ id: EMPLOYEE_ID, employment_start: '2024-01-15', is_active: true }],
          error: null,
        },
        salary_run_employees: { data: [], error: null },
        employee_opening_balances: { data: [SAMPLE_ROW], error: null },
      }),
    )

    const res = await putBalances(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`,
        { method: 'PUT', body: JSON.stringify(VALID_BODY) },
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.employee_opening_balances_id).toBe(ROW_ID)
    expect(body.data.vacation_days_taken_this_year).toBe(2)
    expect(body.data.locked).toBe(false)
  })

  it('rejects vacation_days_taken_this_year below 0', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await putBalances(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`,
        { method: 'PUT', body: JSON.stringify({ ...VALID_BODY, vacation_days_taken_this_year: -1 }) },
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('rejects vacation_days_taken_this_year above 40', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await putBalances(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`,
        { method: 'PUT', body: JSON.stringify({ ...VALID_BODY, vacation_days_taken_this_year: 41 }) },
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('returns 409 OPENING_BALANCES_LOCKED when a booked run exists', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: {
          data: [{ id: EMPLOYEE_ID, employment_start: '2024-01-15', is_active: true }],
          error: null,
        },
        salary_run_employees: {
          data: [{ employee_id: EMPLOYEE_ID, salary_run: { id: RUN_ID, status: 'booked' } }],
          error: null,
        },
      }),
    )

    const res = await putBalances(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`,
        { method: 'PUT', body: JSON.stringify(VALID_BODY) },
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('OPENING_BALANCES_LOCKED')
  })

  it('rejects a cutover_date that is not the first of a month', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await putBalances(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`,
        { method: 'PUT', body: JSON.stringify({ ...VALID_BODY, cutover_date: `${CURRENT_YEAR}-07-15` }) },
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('rejects ytd_tax above ytd_gross', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await putBalances(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`,
        { method: 'PUT', body: JSON.stringify({ ...VALID_BODY, ytd_gross: 1000, ytd_tax: 2000 }) },
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('rejects saved days with an origin year outside the 5-year window', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await putBalances(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`,
        {
          method: 'PUT',
          body: JSON.stringify({
            ...VALID_BODY,
            vacation_saved_days_by_year: { [`${CURRENT_YEAR - 7}`]: 3 },
          }),
        },
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('dry-run validates without writing', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: {
        data: [{ id: EMPLOYEE_ID, employment_start: '2024-01-15', is_active: true }],
        error: null,
      },
      salary_run_employees: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await putBalances(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances?dry_run=true`,
        { method: 'PUT', body: JSON.stringify(VALID_BODY) },
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(supabaseMock.tableCalls).not.toContain('employee_opening_balances')
  })

  it('forces test keys into dry-run on this PUT too', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_test',
      apiKeyName: 'test key',
      scopes: ['payroll:write'],
      mode: 'test',
    })
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: {
        data: [{ id: EMPLOYEE_ID, employment_start: '2024-01-15', is_active: true }],
        error: null,
      },
      salary_run_employees: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await putBalances(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/opening-balances`,
        { method: 'PUT', body: JSON.stringify(VALID_BODY) },
      ),
      detailParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(supabaseMock.tableCalls).not.toContain('employee_opening_balances')
  })
})

describe('PUT /employees/opening-balances (bulk)', () => {
  it('is atomic: one bad item fails everything with a per-item error list', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      // Only the first employee exists.
      employees: {
        data: [{ id: EMPLOYEE_ID, employment_start: '2024-01-15', is_active: true }],
        error: null,
      },
      salary_run_employees: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const otherId = '99999999-9999-4999-8999-999999999999'
    const res = await putBulk(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/opening-balances`, {
        method: 'PUT',
        body: JSON.stringify({
          items: [
            { employee_id: EMPLOYEE_ID, ...VALID_BODY },
            { employee_id: otherId, ...VALID_BODY },
          ],
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    const itemErrors = body.error.details.item_errors as Array<{ index: number; code: string }>
    expect(itemErrors).toHaveLength(1)
    expect(itemErrors[0].index).toBe(1)
    expect(itemErrors[0].code).toBe('EMPLOYEE_NOT_FOUND')
    // Zero writes happened.
    expect(supabaseMock.tableCalls).not.toContain('employee_opening_balances')
  })

  it('upserts all items in one call (happy path)', async () => {
    const secondId = '99999999-9999-4999-8999-999999999999'
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: {
          data: [
            { id: EMPLOYEE_ID, employment_start: '2024-01-15', is_active: true },
            { id: secondId, employment_start: '2025-03-01', is_active: true },
          ],
          error: null,
        },
        salary_run_employees: { data: [], error: null },
        employee_opening_balances: {
          data: [SAMPLE_ROW, { ...SAMPLE_ROW, id: '11111111-1111-4111-8111-111111111111', employee_id: secondId }],
          error: null,
        },
      }),
    )

    const res = await putBulk(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/opening-balances`, {
        method: 'PUT',
        body: JSON.stringify({
          items: [
            { employee_id: EMPLOYEE_ID, ...VALID_BODY },
            { employee_id: secondId, ...VALID_BODY },
          ],
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.count).toBe(2)
  })

  it('rejects duplicate employee_ids in the same request', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await putBulk(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/opening-balances`, {
        method: 'PUT',
        body: JSON.stringify({
          items: [
            { employee_id: EMPLOYEE_ID, ...VALID_BODY },
            { employee_id: EMPLOYEE_ID, ...VALID_BODY },
          ],
        }),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
  })

  it('rejects keys without payroll:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'read-only',
      scopes: ['payroll:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await putBulk(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/opening-balances`, {
        method: 'PUT',
        body: JSON.stringify({ items: [{ employee_id: EMPLOYEE_ID, ...VALID_BODY }] }),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(403)
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await putBulk(
      new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/opening-balances`, {
        method: 'PUT',
        body: JSON.stringify({ items: [{ employee_id: EMPLOYEE_ID, ...VALID_BODY }] }),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(401)
  })
})
