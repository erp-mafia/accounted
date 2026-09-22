/**
 * Tests for the v1 worked-days endpoints (payroll operator gaps).
 *
 * GET/PUT/DELETE /employees/{id}/worked-days. Same harness as the absence
 * route: the real withApiV1 wrapper, validateApiKey mocked with scopes, a
 * per-table flexible Supabase mock injected through createServiceClientNoCookies.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `worked-days route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
import { GET as listWorkedDays, PUT as putWorkedDays, DELETE as deleteWorkedDays } from '../route'

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
  const verbCalls: Array<{ table: string; verb: string; args: unknown[] }> = []
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
        return (...args: unknown[]) => {
          verbCalls.push({ table, verb: String(prop), args })
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return {
    tableCalls,
    verbCalls,
    from: vi.fn((table: string) => {
      tableCalls.push(table)
      return buildChain(table)
    }),
  }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/worked-days`

const SAMPLE_DAY = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  work_date: '2026-03-02',
  hours: 8,
  start_time: '22:00:00',
  end_time: '06:00:00',
  notes: null,
  salary_run_employee_id: null,
  created_at: '2026-03-02T08:00:00Z',
  updated_at: '2026-03-02T08:00:00Z',
}

const OWNER_MEMBERSHIP = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }

/** April 2026 pay month, booked, reading March ("previous_month"): locks 2026-03-01..31. */
const BOOKED_RUN_APRIL_READS_MARCH = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  status: 'booked',
  period_year: 2026,
  period_month: 4,
  deviation_period_start: '2026-03-01',
  deviation_period_end: '2026-03-31',
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

function routeParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

function grantScopes(scopes: string[], mode: 'live' | 'test' = 'live') {
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes,
    mode,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  grantScopes(['payroll:read', 'payroll:write'])
})

describe('GET /api/v1/companies/:companyId/employees/:id/worked-days', () => {
  it('lists worked days with qualified ids and the shift window', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: OWNER_MEMBERSHIP,
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        salary_worked_days: { data: [SAMPLE_DAY], error: null },
      }),
    )

    const res = await listWorkedDays(
      makeRequest(`${BASE}?from=2026-03-01&to=2026-03-31`),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toEqual({
      salary_worked_day_id: SAMPLE_DAY.id,
      work_date: '2026-03-02',
      hours: 8,
      start_time: '22:00:00',
      end_time: '06:00:00',
      notes: null,
      created_at: SAMPLE_DAY.created_at,
      updated_at: SAMPLE_DAY.updated_at,
    })
    expect(body.data[0].id).toBeUndefined()
    expect(body.data[0].salary_run_employee_id).toBeUndefined()
  })

  it('rejects a missing from/to with 400', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: OWNER_MEMBERSHIP }))
    const res = await listWorkedDays(makeRequest(BASE), routeParams(COMPANY_ID, EMPLOYEE_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a reversed range (from > to) with VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: OWNER_MEMBERSHIP }))
    const res = await listWorkedDays(
      makeRequest(`${BASE}?from=2026-03-31&to=2026-03-01`),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a range beyond 92 days with VALIDATION_ERROR and max_days in details', async () => {
    const supabaseMock = makeFlexibleSupabase({ company_members: OWNER_MEMBERSHIP })
    mockServiceClient.mockReturnValue(supabaseMock)
    const res = await listWorkedDays(
      makeRequest(`${BASE}?from=2026-01-01&to=2026-12-31`),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.max_days).toBe(92)
    expect(supabaseMock.tableCalls).not.toContain('salary_worked_days')
  })

  it('accepts a range of exactly 92 days', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: OWNER_MEMBERSHIP,
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        salary_worked_days: { data: [], error: null },
      }),
    )
    const res = await listWorkedDays(
      makeRequest(`${BASE}?from=2026-01-01&to=2026-04-02`),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(200)
  })

  it('returns 404 EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: OWNER_MEMBERSHIP,
        employees: { data: null, error: null },
      }),
    )
    const res = await listWorkedDays(
      makeRequest(`${BASE}?from=2026-03-01&to=2026-03-31`),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('rejects keys without payroll:read scope', async () => {
    grantScopes(['invoices:read'])
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await listWorkedDays(
      makeRequest(`${BASE}?from=2026-03-01&to=2026-03-31`),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(403)
  })
})

describe('PUT /api/v1/companies/:companyId/employees/:id/worked-days', () => {
  const validBody = {
    days: [
      { work_date: '2026-03-02', hours: 8, start_time: '22:00', end_time: '06:00' },
      { work_date: '2026-03-03', hours: 4, notes: 'Halvdag' },
    ],
  }

  it('upserts the days in one statement on the natural key (happy path)', async () => {
    const stored = [
      SAMPLE_DAY,
      {
        ...SAMPLE_DAY,
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        work_date: '2026-03-03',
        hours: 4,
        start_time: null,
        end_time: null,
        notes: 'Halvdag',
      },
    ]
    const supabaseMock = makeFlexibleSupabase({
      company_members: OWNER_MEMBERSHIP,
      employees: { data: { id: EMPLOYEE_ID }, error: null },
      salary_worked_days: { data: stored, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await putWorkedDays(
      makeRequest(BASE, { method: 'PUT', body: JSON.stringify(validBody) }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.count).toBe(2)
    expect(body.data.days[0].salary_worked_day_id).toBe(SAMPLE_DAY.id)
    expect(body.data.days[0].id).toBeUndefined()
    expect(body.data.days[1]).toMatchObject({ work_date: '2026-03-03', hours: 4, notes: 'Halvdag' })

    // Exactly one write against salary_worked_days, as an upsert on the
    // unique index (employee_id, work_date), with every field of each day.
    const writes = supabaseMock.verbCalls.filter(
      (c) => c.table === 'salary_worked_days' && c.verb === 'upsert',
    )
    expect(writes).toHaveLength(1)
    expect(supabaseMock.tableCalls.filter((t) => t === 'salary_worked_days')).toHaveLength(1)
    const [rows, options] = writes[0].args as [Array<Record<string, unknown>>, { onConflict: string }]
    expect(options.onConflict).toBe('employee_id,work_date')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      company_id: COMPANY_ID,
      employee_id: EMPLOYEE_ID,
      work_date: '2026-03-02',
      hours: 8,
      start_time: '22:00',
      end_time: '06:00',
      notes: null,
      salary_run_employee_id: null,
    })
    expect(rows[1]).toMatchObject({ work_date: '2026-03-03', hours: 4, start_time: null, end_time: null, notes: 'Halvdag' })
  })

  it('rejects an empty days array with 400', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: OWNER_MEMBERSHIP }))
    const res = await putWorkedDays(
      makeRequest(BASE, { method: 'PUT', body: JSON.stringify({ days: [] }) }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects half a shift window (start_time without end_time) with 400', async () => {
    const supabaseMock = makeFlexibleSupabase({ company_members: OWNER_MEMBERSHIP })
    mockServiceClient.mockReturnValue(supabaseMock)
    const res = await putWorkedDays(
      makeRequest(BASE, {
        method: 'PUT',
        body: JSON.stringify({ days: [{ work_date: '2026-03-02', hours: 8, start_time: '22:00' }] }),
      }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues[0].field).toBe('days.0.start_time')
    expect(supabaseMock.tableCalls).not.toContain('salary_worked_days')
  })

  it('rejects more than 92 days with 400', async () => {
    const days = Array.from({ length: 93 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + i))
      return { work_date: d.toISOString().slice(0, 10), hours: 8 }
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: OWNER_MEMBERSHIP }))
    const res = await putWorkedDays(
      makeRequest(BASE, { method: 'PUT', body: JSON.stringify({ days }) }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('rejects the same work_date twice in one request with 400', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: OWNER_MEMBERSHIP,
      employees: { data: { id: EMPLOYEE_ID }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)
    const res = await putWorkedDays(
      makeRequest(BASE, {
        method: 'PUT',
        body: JSON.stringify({
          days: [
            { work_date: '2026-03-02', hours: 8 },
            { work_date: '2026-03-02', hours: 4 },
          ],
        }),
      }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.duplicate_dates).toEqual(['2026-03-02'])
    expect(supabaseMock.tableCalls).not.toContain('salary_worked_days')
  })

  it('maps the shared 24h trigger to 409 ABSENCE_HOURS_CONFLICT', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: OWNER_MEMBERSHIP,
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        salary_worked_days: {
          data: null,
          error: {
            code: '23514',
            message:
              'Total tid (arbete + frånvaro) för 2026-03-02 får inte överstiga 24 timmar (försökte boka 20, befintligt 8)',
          },
        },
      }),
    )

    const res = await putWorkedDays(
      makeRequest(BASE, { method: 'PUT', body: JSON.stringify(validBody) }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ABSENCE_HOURS_CONFLICT')
    expect(body.error.details.message).toMatch(/Total tid/)
  })

  it('refuses dates a booked run has already read through its deviation window: 409 SALARY_REGISTER_DATES_LOCKED_BY_RUN, nothing written', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: OWNER_MEMBERSHIP,
      employees: { data: { id: EMPLOYEE_ID }, error: null },
      salary_runs: { data: [BOOKED_RUN_APRIL_READS_MARCH], error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await putWorkedDays(
      makeRequest(BASE, { method: 'PUT', body: JSON.stringify(validBody) }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
    expect(body.error.details).toMatchObject({
      salary_run_id: BOOKED_RUN_APRIL_READS_MARCH.id,
      status: 'booked',
      deviation_period_start: '2026-03-01',
      deviation_period_end: '2026-03-31',
      locked_dates: ['2026-03-02', '2026-03-03'],
    })
    expect(supabaseMock.tableCalls).not.toContain('salary_worked_days')
  })

  it('returns 404 EMPLOYEE_NOT_FOUND without writing', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: OWNER_MEMBERSHIP,
      employees: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)
    const res = await putWorkedDays(
      makeRequest(BASE, { method: 'PUT', body: JSON.stringify(validBody) }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
    expect(supabaseMock.tableCalls).not.toContain('salary_worked_days')
  })

  it('returns a dry-run preview of the would-be rows without writing', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: OWNER_MEMBERSHIP,
      employees: { data: { id: EMPLOYEE_ID }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await putWorkedDays(
      makeRequest(`${BASE}?dry_run=true`, { method: 'PUT', body: JSON.stringify(validBody) }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.count).toBe(2)
    expect(body.data.preview.days[0]).toEqual({
      work_date: '2026-03-02',
      hours: 8,
      start_time: '22:00',
      end_time: '06:00',
      notes: null,
    })
    expect(body.data.preview.days[1]).toEqual({
      work_date: '2026-03-03',
      hours: 4,
      start_time: null,
      end_time: null,
      notes: 'Halvdag',
    })
    expect(supabaseMock.tableCalls).not.toContain('salary_worked_days')
  })

  it('forces TEST KEYS into dry-run on PUT', async () => {
    grantScopes(['payroll:read', 'payroll:write'], 'test')
    const supabaseMock = makeFlexibleSupabase({
      company_members: OWNER_MEMBERSHIP,
      employees: { data: { id: EMPLOYEE_ID }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await putWorkedDays(
      makeRequest(BASE, { method: 'PUT', body: JSON.stringify(validBody) }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(supabaseMock.tableCalls).not.toContain('salary_worked_days')
  })

  it('rejects keys without payroll:write scope', async () => {
    grantScopes(['payroll:read'])
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await putWorkedDays(
      makeRequest(BASE, { method: 'PUT', body: JSON.stringify(validBody) }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(403)
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await putWorkedDays(
      new Request(BASE, { method: 'PUT', body: JSON.stringify(validBody) }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/v1/companies/:companyId/employees/:id/worked-days', () => {
  it('deletes the range and returns deleted_count', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: OWNER_MEMBERSHIP,
      employees: { data: { id: EMPLOYEE_ID }, error: null },
      salary_worked_days: { data: null, error: null, count: 3 },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await deleteWorkedDays(
      makeRequest(`${BASE}?from=2026-03-01&to=2026-03-31`, { method: 'DELETE' }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.deleted_count).toBe(3)
    expect(
      supabaseMock.verbCalls.some((c) => c.table === 'salary_worked_days' && c.verb === 'delete'),
    ).toBe(true)
  })

  it('dry-run counts the would-be deletions without deleting', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: OWNER_MEMBERSHIP,
      employees: { data: { id: EMPLOYEE_ID }, error: null },
      salary_worked_days: { data: null, error: null, count: 2 },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await deleteWorkedDays(
      makeRequest(`${BASE}?from=2026-03-01&to=2026-03-31&dry_run=true`, { method: 'DELETE' }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview.deleted_count).toBe(2)
    expect(
      supabaseMock.verbCalls.some((c) => c.table === 'salary_worked_days' && c.verb === 'delete'),
    ).toBe(false)
  })

  it('requires from and to', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: OWNER_MEMBERSHIP }))
    const res = await deleteWorkedDays(
      makeRequest(BASE, { method: 'DELETE' }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: OWNER_MEMBERSHIP,
        employees: { data: null, error: null },
      }),
    )
    const res = await deleteWorkedDays(
      makeRequest(`${BASE}?from=2026-03-01&to=2026-03-31`, { method: 'DELETE' }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('rejects keys without payroll:write scope', async () => {
    grantScopes(['payroll:read'])
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await deleteWorkedDays(
      makeRequest(`${BASE}?from=2026-03-01&to=2026-03-31`, { method: 'DELETE' }),
      routeParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(403)
  })
})
