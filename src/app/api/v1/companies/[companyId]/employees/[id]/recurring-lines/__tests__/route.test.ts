/**
 * Tests for the v1 recurring-lines collection endpoints (payroll gap-closure 5).
 *
 * GET/POST /employees/{id}/recurring-lines. Harness mirrors the absence
 * route tests: the real withApiV1 wrapper runs, with the API-key validator
 * and the service client mocked.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `recurring-lines route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
import { GET as listLines, POST as createLine } from '../route'

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
const LINE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const USER_ID = 'user-1'

const SAMPLE_LINE = {
  id: LINE_ID,
  employee_id: EMPLOYEE_ID,
  company_id: COMPANY_ID,
  user_id: USER_ID,
  item_type: 'gross_deduction_other',
  description: 'Förmånscykel bruttolöneavdrag',
  amount: -670.17,
  account_number: null,
  valid_from: '2026-01-01',
  valid_to: null,
  metadata: {},
  is_active: true,
  created_at: '2026-01-01T08:00:00Z',
  updated_at: '2026-01-01T08:00:00Z',
}

const BASE_URL = `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/recurring-lines`

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ...(init?.headers ?? {}),
    },
  })
}

function lineParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

const membership = { company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null } }

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

describe('GET /api/v1/companies/:companyId/employees/:id/recurring-lines', () => {
  it('lists lines with the qualified id and no tenancy columns', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        employee_recurring_lines: { data: [SAMPLE_LINE], error: null },
      }),
    )

    const res = await listLines(makeRequest(BASE_URL), lineParams(COMPANY_ID, EMPLOYEE_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toEqual({
      employee_recurring_line_id: LINE_ID,
      item_type: 'gross_deduction_other',
      description: 'Förmånscykel bruttolöneavdrag',
      amount: -670.17,
      account_number: null,
      valid_from: '2026-01-01',
      valid_to: null,
      is_active: true,
      metadata: {},
      created_at: '2026-01-01T08:00:00Z',
      updated_at: '2026-01-01T08:00:00Z',
    })
  })

  it('accepts ?active=true', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        employee_recurring_lines: { data: [], error: null },
      }),
    )
    const res = await listLines(makeRequest(`${BASE_URL}?active=true`), lineParams(COMPANY_ID, EMPLOYEE_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([])
  })

  it('rejects an unknown ?active value with VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase(membership))
    const res = await listLines(makeRequest(`${BASE_URL}?active=yes`), lineParams(COMPANY_ID, EMPLOYEE_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a non-UUID employee id with VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase(membership))
    const res = await listLines(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/nope/recurring-lines`),
      lineParams(COMPANY_ID, 'nope'),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        employees: { data: null, error: null },
      }),
    )
    const res = await listLines(makeRequest(BASE_URL), lineParams(COMPANY_ID, EMPLOYEE_ID))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await listLines(new Request(BASE_URL), lineParams(COMPANY_ID, EMPLOYEE_ID))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/v1/companies/:companyId/employees/:id/recurring-lines', () => {
  const validBody = {
    item_type: 'gross_deduction_other',
    description: 'Förmånscykel bruttolöneavdrag',
    amount: -670.17,
    valid_from: '2026-01-01',
  }

  it('creates a line and returns 201 with the qualified id (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        employee_recurring_lines: { data: SAMPLE_LINE, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createLine(
      makeRequest(BASE_URL, { method: 'POST', body: JSON.stringify(validBody) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.employee_recurring_line_id).toBe(LINE_ID)
    expect(body.data.amount).toBe(-670.17)
    expect(body.data.company_id).toBeUndefined()
    expect(body.data.user_id).toBeUndefined()
  })

  it('rejects a positive amount on a deduction type with a field-level 400', async () => {
    const supabaseMock = makeFlexibleSupabase({ ...membership, idempotency_keys: { data: null, error: null } })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await createLine(
      makeRequest(BASE_URL, { method: 'POST', body: JSON.stringify({ ...validBody, amount: 670.17 }) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'amount' })]),
    )
    expect(supabaseMock.tableCalls).not.toContain('employee_recurring_lines')
  })

  it('rejects valid_to before valid_from with a field-level 400', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ ...membership, idempotency_keys: { data: null, error: null } }),
    )

    const res = await createLine(
      makeRequest(BASE_URL, {
        method: 'POST',
        body: JSON.stringify({ ...validBody, valid_from: '2026-06-01', valid_to: '2026-05-31' }),
      }),
      lineParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'valid_to' })]),
    )
  })

  it('returns 404 EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        employees: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createLine(
      makeRequest(BASE_URL, { method: 'POST', body: JSON.stringify(validBody) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('returns a dry-run preview without writing', async () => {
    const supabaseMock = makeFlexibleSupabase({
      ...membership,
      employees: { data: { id: EMPLOYEE_ID }, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await createLine(
      makeRequest(`${BASE_URL}?dry_run=true`, { method: 'POST', body: JSON.stringify(validBody) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.amount).toBe(-670.17)
    expect(body.data.preview.employee_recurring_line_id).toBeUndefined()
    expect(supabaseMock.tableCalls).not.toContain('employee_recurring_lines')
  })

  it('returns 400 when Idempotency-Key is missing', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase(membership))

    const res = await createLine(
      new Request(BASE_URL, {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
      }),
      lineParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
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

    const res = await createLine(
      makeRequest(BASE_URL, { method: 'POST', body: JSON.stringify(validBody) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(403)
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await createLine(
      new Request(BASE_URL, { method: 'POST', body: JSON.stringify(validBody) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(401)
  })
})
