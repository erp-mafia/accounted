/**
 * Tests for the v1 recurring-line item endpoints (payroll gap-closure 5).
 *
 * PATCH/DELETE /employees/{id}/recurring-lines/{lineId}. Harness mirrors the
 * absence route tests: the real withApiV1 wrapper runs, with the API-key
 * validator and the service client mocked.
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
import { PATCH as updateLine, DELETE as deleteLine } from '../route'

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

const STORED_LINE = {
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

const LINE_URL = `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/recurring-lines/${LINE_ID}`

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

function lineParams(companyId: string, id: string, lineId: string) {
  return { params: Promise.resolve({ companyId, id, lineId }) }
}

const membership = { company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null } }
const noIdempotencyHit = { idempotency_keys: { data: null, error: null } }

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

describe('PATCH /api/v1/companies/:companyId/employees/:id/recurring-lines/:lineId', () => {
  it('updates the amount and returns the qualified resource (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        ...noIdempotencyHit,
        employee_recurring_lines: [
          { data: STORED_LINE, error: null }, // fetch existing
          { data: { ...STORED_LINE, amount: -700 }, error: null }, // update
        ],
      }),
    )

    const res = await updateLine(
      makeRequest(LINE_URL, { method: 'PATCH', body: JSON.stringify({ amount: -700 }) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.employee_recurring_line_id).toBe(LINE_ID)
    expect(body.data.amount).toBe(-700)
    expect(body.data.id).toBeUndefined()
    expect(body.data.company_id).toBeUndefined()
  })

  it('returns 404 NOT_FOUND when the line is not under this employee', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        ...noIdempotencyHit,
        employee_recurring_lines: { data: null, error: null },
      }),
    )

    const res = await updateLine(
      makeRequest(LINE_URL, { method: 'PATCH', body: JSON.stringify({ amount: -700 }) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.details.employee_recurring_line_id).toBe(LINE_ID)
  })

  it('rejects an amount whose sign contradicts the stored item_type', async () => {
    const supabaseMock = makeFlexibleSupabase({
      ...membership,
      ...noIdempotencyHit,
      employee_recurring_lines: { data: STORED_LINE, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateLine(
      makeRequest(LINE_URL, { method: 'PATCH', body: JSON.stringify({ amount: 700 }) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues).toEqual([expect.objectContaining({ field: 'amount' })])
  })

  it('rejects a patched valid_to that lands before the stored valid_from', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        ...noIdempotencyHit,
        employee_recurring_lines: { data: { ...STORED_LINE, valid_from: '2026-06-01' }, error: null },
      }),
    )

    const res = await updateLine(
      makeRequest(LINE_URL, { method: 'PATCH', body: JSON.stringify({ valid_to: '2026-05-31' }) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.issues).toEqual([expect.objectContaining({ field: 'valid_to' })])
  })

  it('rejects an empty body with VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ ...membership, ...noIdempotencyHit }))

    const res = await updateLine(
      makeRequest(LINE_URL, { method: 'PATCH', body: JSON.stringify({}) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a non-UUID lineId with VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ ...membership, ...noIdempotencyHit }))

    const res = await updateLine(
      makeRequest(LINE_URL.replace(LINE_ID, 'nope'), { method: 'PATCH', body: JSON.stringify({ amount: -700 }) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, 'nope'),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.field).toBe('lineId')
  })

  it('returns a dry-run preview of the merged row without writing', async () => {
    const supabaseMock = makeFlexibleSupabase({
      ...membership,
      ...noIdempotencyHit,
      employee_recurring_lines: { data: STORED_LINE, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await updateLine(
      makeRequest(`${LINE_URL}?dry_run=true`, {
        method: 'PATCH',
        body: JSON.stringify({ amount: -700, valid_to: '2026-12-31' }),
      }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview.amount).toBe(-700)
    expect(body.data.preview.valid_to).toBe('2026-12-31')
    // One read (the fetch), no write.
    expect(supabaseMock.tableCalls.filter((t) => t === 'employee_recurring_lines')).toHaveLength(1)
  })

  it('returns 400 when Idempotency-Key is missing', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase(membership))

    const res = await updateLine(
      new Request(LINE_URL, {
        method: 'PATCH',
        body: JSON.stringify({ amount: -700 }),
        headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
      }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
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

    const res = await updateLine(
      makeRequest(LINE_URL, { method: 'PATCH', body: JSON.stringify({ amount: -700 }) }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )
    expect(res.status).toBe(403)
  })
})

describe('DELETE /api/v1/companies/:companyId/employees/:id/recurring-lines/:lineId', () => {
  it('hard-deletes a line no run has derived from', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        ...noIdempotencyHit,
        employee_recurring_lines: { data: { id: LINE_ID }, error: null },
      }),
    )

    const res = await deleteLine(
      makeRequest(LINE_URL, { method: 'DELETE' }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ employee_recurring_line_id: LINE_ID, deleted: true })
  })

  it('deactivates instead of deleting when derived rows reference the line', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        ...noIdempotencyHit,
        employee_recurring_lines: [
          { data: null, error: { code: '23503', message: 'violates foreign key constraint' } }, // delete
          { data: null, error: null }, // is_active=false update
        ],
      }),
    )

    const res = await deleteLine(
      makeRequest(LINE_URL, { method: 'DELETE' }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      employee_recurring_line_id: LINE_ID,
      deleted: false,
      deactivated: true,
    })
  })

  it('returns 404 NOT_FOUND when the delete matches nothing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        ...noIdempotencyHit,
        employee_recurring_lines: { data: null, error: null },
      }),
    )

    const res = await deleteLine(
      makeRequest(LINE_URL, { method: 'DELETE' }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('previews the deactivation outcome on dry run without writing', async () => {
    const supabaseMock = makeFlexibleSupabase({
      ...membership,
      ...noIdempotencyHit,
      employee_recurring_lines: { data: { id: LINE_ID }, error: null },
      salary_line_items: { data: null, error: null, count: 1 },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await deleteLine(
      makeRequest(`${LINE_URL}?dry_run=true`, { method: 'DELETE' }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview).toEqual({
      employee_recurring_line_id: LINE_ID,
      deleted: false,
      deactivated: true,
    })
  })

  it('forces TEST KEYS into dry-run on DELETE', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_test',
      apiKeyName: 'test key',
      scopes: ['payroll:read', 'payroll:write'],
      mode: 'test',
    })
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        ...membership,
        ...noIdempotencyHit,
        employee_recurring_lines: { data: { id: LINE_ID }, error: null },
        salary_line_items: { data: null, error: null, count: 0 },
      }),
    )

    const res = await deleteLine(
      makeRequest(LINE_URL, { method: 'DELETE' }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(res.headers.get('X-Gnubok-Mode')).toBe('test')
    const body = await res.json()
    expect(body.data.preview).toEqual({ employee_recurring_line_id: LINE_ID, deleted: true })
  })

  it('returns 400 when Idempotency-Key is missing', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase(membership))

    const res = await deleteLine(
      new Request(LINE_URL, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
      }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )

    expect(res.status).toBe(400)
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await deleteLine(
      new Request(LINE_URL, { method: 'DELETE' }),
      lineParams(COMPANY_ID, EMPLOYEE_ID, LINE_ID),
    )
    expect(res.status).toBe(401)
  })
})
