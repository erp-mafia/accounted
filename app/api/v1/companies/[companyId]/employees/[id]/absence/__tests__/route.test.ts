/**
 * Tests for the v1 absence endpoints (payroll gap-closure 1.4).
 *
 * GET/PUT/DELETE /employees/{id}/absence. PUT is the first PUT route on v1:
 * the wrapper's REQUIRES_IDEMPOTENCY set was extended to include it, and the
 * test-key case below is the regression test for that hole (a test key on a
 * PUT must be forced into dry-run, never write through).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `absence route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
import { GET as listAbsence, PUT as putAbsence, DELETE as deleteAbsence } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
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
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null, count: null })
            resolve({ count: null, ...next })
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
const USER_ID = 'user-1'

const SAMPLE_DAY = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  absence_date: '2026-03-03',
  absence_type: 'sick',
  hours: 8,
  notes: null,
  salary_run_employee_id: null,
  created_at: '2026-03-03T08:00:00Z',
  updated_at: '2026-03-03T08:00:00Z',
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

function absenceParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
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

describe('GET /api/v1/companies/:companyId/employees/:id/absence', () => {
  it('lists absence days with qualified ids', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        salary_absence_days: { data: [SAMPLE_DAY], error: null },
      }),
    )

    const res = await listAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence?from=2026-03-01&to=2026-03-31`,
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].salary_absence_day_id).toBe(SAMPLE_DAY.id)
    expect(body.data[0].id).toBeUndefined()
  })

  it('rejects a missing from/to with 400', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await listAbsence(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence`),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('rejects a reversed range (from > to) with VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await listAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence?from=2026-03-31&to=2026-03-01`,
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a range beyond 92 days with ABSENCE_RANGE_TOO_LARGE', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await listAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence?from=2026-01-01&to=2026-12-31`,
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('ABSENCE_RANGE_TOO_LARGE')
  })

  it('returns 404 EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: null, error: null },
      }),
    )
    const res = await listAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence?from=2026-03-01&to=2026-03-31`,
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })
})

describe('PUT /api/v1/companies/:companyId/employees/:id/absence', () => {
  const validBody = { from: '2026-03-02', to: '2026-03-06', absence_type: 'sick' }

  it('upserts the expanded range (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        salary_absence_days: [
          { data: [SAMPLE_DAY, { ...SAMPLE_DAY, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', absence_date: '2026-03-04' }], error: null }, // bulk upsert
        ],
      }),
    )

    const res = await putAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence`,
        { method: 'PUT', body: JSON.stringify(validBody) },
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.count).toBe(2)
    expect(body.data.days[0].salary_absence_day_id).toBeTruthy()
  })

  it('rejects from > to with 400', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await putAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence`,
        { method: 'PUT', body: JSON.stringify({ ...validBody, from: '2026-03-10' }) },
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('maps the 24h trigger to 409 ABSENCE_HOURS_CONFLICT', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        salary_absence_days: [
          { data: null, error: { code: '23514', message: 'Total tid över 24h' } },
        ],
      }),
    )

    const res = await putAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence`,
        { method: 'PUT', body: JSON.stringify(validBody) },
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ABSENCE_HOURS_CONFLICT')
  })

  it('returns a dry-run preview without writing', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: { data: { id: EMPLOYEE_ID }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await putAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence?dry_run=true`,
        { method: 'PUT', body: JSON.stringify(validBody) },
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview.count).toBe(5)
    expect(supabaseMock.tableCalls).not.toContain('salary_absence_days')
  })

  it('forces TEST KEYS into dry-run on PUT (wrapper REQUIRES_IDEMPOTENCY regression)', async () => {
    // Before the wrapper hardening, PUT was missing from REQUIRES_IDEMPOTENCY:
    // a test key would have written through. This test locks the fix in.
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_test',
      apiKeyName: 'test key',
      scopes: ['payroll:read', 'payroll:write'],
      mode: 'test',
    })
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      employees: { data: { id: EMPLOYEE_ID }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await putAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence`,
        { method: 'PUT', body: JSON.stringify(validBody) },
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(res.headers.get('X-Gnubok-Mode')).toBe('test')
    // The write table was never touched.
    expect(supabaseMock.tableCalls).not.toContain('salary_absence_days')
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

    const res = await putAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence`,
        { method: 'PUT', body: JSON.stringify(validBody) },
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(403)
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await putAbsence(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence`,
        { method: 'PUT', body: JSON.stringify(validBody) },
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/v1/companies/:companyId/employees/:id/absence', () => {
  it('deletes the range and returns deleted_count', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        salary_absence_days: { data: null, error: null, count: 3 },
      }),
    )

    const res = await deleteAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence?from=2026-03-01&to=2026-03-31&type=sick`,
        { method: 'DELETE' },
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.deleted_count).toBe(3)
  })

  it('requires from and to', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await deleteAbsence(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/absence`,
        { method: 'DELETE' },
      ),
      absenceParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
  })
})
