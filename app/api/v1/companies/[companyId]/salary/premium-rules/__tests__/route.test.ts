/**
 * Tests for the v1 premium-rules endpoints (list/create + update/delete).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`premium-rules route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`)
  }
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
import { GET as listRules, POST as createRule } from '../route'
import { PATCH as patchRule, DELETE as deleteRule } from '../[id]/route'

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
  const calls: { table: string; method: string; args: unknown[] }[] = []
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
          calls.push({ table, method: String(prop), args })
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return {
    calls,
    from: vi.fn((table: string) => buildChain(table)),
  }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RULE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EMP_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EMP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const STORED_RULE = {
  id: RULE_ID,
  company_id: COMPANY_ID,
  name: 'OB natt',
  applies_to_all_employees: true,
  applies_to_employee_ids: [],
  day_of_week: [1, 2, 3, 4, 5, 6, 7],
  start_time: '22:00:00',
  end_time: '06:00:00',
  premium_percent: '70.00',
  item_type: 'ob_night',
  priority: 10,
  is_active: true,
  created_at: '2026-09-11T08:00:00Z',
  updated_at: '2026-09-11T08:00:00Z',
  created_by: 'user-1',
}

const VALID_BODY = {
  name: 'OB natt',
  day_of_week: [1, 2, 3, 4, 5, 6, 7],
  start_time: '22:00',
  end_time: '06:00',
  premium_percent: 70,
  item_type: 'ob_night',
  priority: 10,
}

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

const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/salary/premium-rules`
const listParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const ruleParams = (id: string) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

const members = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['payroll:read', 'payroll:write'],
    mode: 'live',
  })
})

describe('GET /salary/premium-rules', () => {
  it('lists rules with qualified ids and HH:MM times', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: members,
        shift_premium_rules: { data: [STORED_RULE], error: null },
      }),
    )
    const res = await listRules(makeRequest(BASE), listParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].premium_rule_id).toBe(RULE_ID)
    expect(body.data[0].id).toBeUndefined()
    expect(body.data[0].company_id).toBeUndefined()
    expect(body.data[0].start_time).toBe('22:00')
    expect(body.data[0].premium_percent).toBe(70)
  })

  it('returns 401 without a bearer token', async () => {
    const res = await listRules(new Request(BASE), listParams)
    expect(res.status).toBe(401)
  })

  it('rejects keys without payroll:read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'CI key',
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: members }))
    const res = await listRules(makeRequest(BASE), listParams)
    expect(res.status).toBe(403)
  })
})

describe('POST /salary/premium-rules', () => {
  it('creates a rule (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: members,
        idempotency_keys: { data: null, error: null },
        shift_premium_rules: { data: STORED_RULE, error: null },
      }),
    )
    const res = await createRule(
      makeRequest(BASE, { method: 'POST', body: JSON.stringify(VALID_BODY) }),
      listParams,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.premium_rule_id).toBe(RULE_ID)
    expect(body.data.end_time).toBe('06:00')
  })

  it('rejects an inconsistent scope with 400', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ company_members: members, idempotency_keys: { data: null, error: null } }),
    )
    const res = await createRule(
      makeRequest(BASE, {
        method: 'POST',
        body: JSON.stringify({ ...VALID_BODY, applies_to_all_employees: false }),
      }),
      listParams,
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 with the foreign ids when a named employee is not in the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: members,
        idempotency_keys: { data: null, error: null },
        employees: { data: [{ id: EMP_A }], error: null },
      }),
    )
    const res = await createRule(
      makeRequest(BASE, {
        method: 'POST',
        body: JSON.stringify({
          ...VALID_BODY,
          applies_to_all_employees: false,
          applies_to_employee_ids: [EMP_A, EMP_B],
        }),
      }),
      listParams,
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND')
    expect(body.error.details.missing_employee_ids).toEqual([EMP_B])
  })

  it('returns a dry-run preview without writing', async () => {
    const supabase = makeFlexibleSupabase({
      company_members: members,
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    const res = await createRule(
      makeRequest(`${BASE}?dry_run=true`, { method: 'POST', body: JSON.stringify(VALID_BODY) }),
      listParams,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(supabase.calls.find((c) => c.table === 'shift_premium_rules')).toBeUndefined()
  })
})

describe('PATCH /salary/premium-rules/:id', () => {
  it('rejects a non-UUID id', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: members }))
    const res = await patchRule(
      makeRequest(`${BASE}/not-a-uuid`, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) }),
      ruleParams('not-a-uuid'),
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown rule', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: members,
        idempotency_keys: { data: null, error: null },
        shift_premium_rules: { data: null, error: null },
      }),
    )
    const res = await patchRule(
      makeRequest(`${BASE}/${RULE_ID}`, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) }),
      ruleParams(RULE_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SHIFT_PREMIUM_RULE_NOT_FOUND')
  })

  it('updates the percent (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: members,
        idempotency_keys: { data: null, error: null },
        shift_premium_rules: [
          { data: STORED_RULE, error: null },
          { data: { ...STORED_RULE, premium_percent: '75.00' }, error: null },
        ],
      }),
    )
    const res = await patchRule(
      makeRequest(`${BASE}/${RULE_ID}`, { method: 'PATCH', body: JSON.stringify({ premium_percent: 75 }) }),
      ruleParams(RULE_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.premium_percent).toBe(75)
    expect(body.data.premium_rule_id).toBe(RULE_ID)
  })

  it('rejects a scope flip that leaves nobody covered', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: members,
        idempotency_keys: { data: null, error: null },
        shift_premium_rules: { data: STORED_RULE, error: null },
      }),
    )
    const res = await patchRule(
      makeRequest(`${BASE}/${RULE_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ applies_to_all_employees: false }),
      }),
      ruleParams(RULE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SHIFT_PREMIUM_RULE_SCOPE_INVALID')
  })
})

describe('DELETE /salary/premium-rules/:id', () => {
  it('deletes and returns 204', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: members,
        idempotency_keys: { data: null, error: null },
        shift_premium_rules: { data: [{ id: RULE_ID }], error: null },
      }),
    )
    const res = await deleteRule(makeRequest(`${BASE}/${RULE_ID}`, { method: 'DELETE' }), ruleParams(RULE_ID))
    expect(res.status).toBe(204)
  })

  it('returns 404 when nothing matched', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: members,
        idempotency_keys: { data: null, error: null },
        shift_premium_rules: { data: [], error: null },
      }),
    )
    const res = await deleteRule(makeRequest(`${BASE}/${RULE_ID}`, { method: 'DELETE' }), ruleParams(RULE_ID))
    expect(res.status).toBe(404)
  })
})
