/**
 * Account dimension rules through the v1 door of the operation registry
 * (src/lib/operations/dimension-rules.ts over lib/dimensions/rules-service.ts):
 *   GET    /api/v1/companies/:companyId/dimensions/rules
 *   POST   /api/v1/companies/:companyId/dimensions/rules
 *   PATCH  /api/v1/companies/:companyId/dimensions/rules/:id
 *   DELETE /api/v1/companies/:companyId/dimensions/rules/:id
 *
 * Before these the policy could only be set in the dashboard's account
 * dialog: an API customer saw MANDATORY_DIMENSION_MISSING with no way to
 * read or change the rule behind it.
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
import { GET as listRules, POST as createRule } from '../rules/route'
import { PATCH as updateRule, DELETE as deleteRule } from '../rules/[id]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

/** Per-table queue mock that also records every (table, method, args). */
function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (key: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(key)
              resolve(q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null }))
            }
          }
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key)
          }
        },
      },
    )
  return {
    calls,
    from: vi.fn((table: string) => buildChain(table)),
    rpc: vi.fn(() => buildChain('rpc')),
  }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DIM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const VALUE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RULE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/dimensions/rules`

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const ruleParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: RULE_ID }) }

/** A row exactly as RULE_SELECT returns it (joined registry aliases). */
function rawRule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    account_number: '4010',
    rule_type: 'required',
    value_id: null,
    is_active: true,
    dimension: { id: DIM_ID, sie_dim_no: 6, name: 'Projekt' },
    value: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read', 'bookkeeping:write'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/dimensions/rules', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    const res = await listRules(request(BASE), companyParams)
    expect(res.status).toBe(401)
  })

  it('400 VALIDATION_ERROR for an account filter that is not an account number', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await listRules(request(`${BASE}?account_number=40`), companyParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('200 with the rules in the dashboard DTO, filtered by account and scoped to the company', async () => {
    const client = makeClient({
      company_members: MEMBER,
      account_dimension_rules: { data: [rawRule(), rawRule({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', rule_type: 'fixed', value_id: VALUE_ID, value: { code: 'P001', name: 'Villa' } })], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await listRules(request(`${BASE}?account_number=4010`), companyParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.rules).toHaveLength(2)
    expect(body.data.rules[0]).toEqual({
      account_dimension_rule_id: RULE_ID,
      account_number: '4010',
      dimension_id: DIM_ID,
      sie_dim_no: 6,
      dimension_name: 'Projekt',
      rule_type: 'required',
      value_id: null,
      value_code: null,
      value_name: null,
      is_active: true,
    })
    expect(body.data.rules[1]).toMatchObject({ rule_type: 'fixed', value_code: 'P001' })
    const filters = client.calls.filter((c) => c.table === 'account_dimension_rules' && c.method === 'eq')
    expect(filters.map((c) => c.args)).toEqual([
      ['company_id', COMPANY_ID],
      ['account_number', '4010'],
    ])
  })
})

describe('POST /api/v1/companies/:companyId/dimensions/rules', () => {
  const post = (body: Record<string, unknown>, query = '') =>
    createRule(request(`${BASE}${query}`, { method: 'POST', body: JSON.stringify(body) }), companyParams)

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await post({ account_number: '4010', dimension_id: DIM_ID, rule_type: 'required' })
    expect(res.status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a required rule that carries a value, nothing read or written', async () => {
    const client = makeClient({ company_members: MEMBER })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ account_number: '4010', dimension_id: DIM_ID, rule_type: 'required', value_id: VALUE_ID })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(client.calls.some((c) => c.table === 'account_dimension_rules')).toBe(false)
  })

  it('404 DIMENSION_NOT_FOUND for a dimension the company does not have', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, dimensions: { data: null, error: null } }))
    const res = await post({ account_number: '4010', dimension_id: DIM_ID, rule_type: 'required' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('DIMENSION_NOT_FOUND')
  })

  it('400 DIMENSION_VALUE_ARCHIVED for a default rule on an archived value', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        dimensions: { data: { id: DIM_ID, is_active: true }, error: null },
        dimension_values: { data: { id: VALUE_ID, is_active: false }, error: null },
      }),
    )
    const res = await post({ account_number: '4010', dimension_id: DIM_ID, rule_type: 'default', value_id: VALUE_ID })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('DIMENSION_VALUE_ARCHIVED')
  })

  it('409 DIMENSION_RULE_EXISTS when the account already has a rule for the dimension', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        dimensions: { data: { id: DIM_ID, is_active: true }, error: null },
        chart_of_accounts: { data: { account_number: '4010' }, error: null },
        account_dimension_rules: { data: null, error: { code: '23505', message: 'duplicate key value' } },
      }),
    )
    const res = await post({ account_number: '4010', dimension_id: DIM_ID, rule_type: 'required' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('DIMENSION_RULE_EXISTS')
  })

  it('201 with the created rule', async () => {
    const client = makeClient({
      company_members: MEMBER,
      dimensions: { data: { id: DIM_ID, is_active: true }, error: null },
      chart_of_accounts: { data: { account_number: '4010' }, error: null },
      account_dimension_rules: { data: rawRule(), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ account_number: '4010', dimension_id: DIM_ID, rule_type: 'required' })
    expect(res.status).toBe(201)
    expect((await res.json()).data.rule).toMatchObject({ account_dimension_rule_id: RULE_ID, rule_type: 'required' })
    const insert = client.calls.find((c) => c.table === 'account_dimension_rules' && c.method === 'insert')
    expect(insert?.args[0]).toEqual({
      company_id: COMPANY_ID,
      account_number: '4010',
      dimension_id: DIM_ID,
      rule_type: 'required',
      value_id: null,
      is_active: true,
    })
  })

  it('a dry run refuses a duplicate up front and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      dimensions: { data: { id: DIM_ID, is_active: true }, error: null },
      chart_of_accounts: { data: { account_number: '4010' }, error: null },
      account_dimension_rules: { data: { id: RULE_ID }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ account_number: '4010', dimension_id: DIM_ID, rule_type: 'required' }, '?dry_run=true')
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('DIMENSION_RULE_EXISTS')
    expect(body.error.details).toMatchObject({ account_dimension_rule_id: RULE_ID })
    expect(client.calls.some((c) => c.method === 'insert')).toBe(false)
  })
})

describe('PATCH /api/v1/companies/:companyId/dimensions/rules/:id', () => {
  const patch = (body: Record<string, unknown>) =>
    updateRule(request(`${BASE}/${RULE_ID}`, { method: 'PATCH', body: JSON.stringify(body) }), ruleParams)

  it('400 VALIDATION_ERROR when nothing is sent', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await patch({})
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 DIMENSION_RULE_NOT_FOUND for a rule of another company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, account_dimension_rules: { data: null, error: null } }))
    const res = await patch({ is_active: false })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('DIMENSION_RULE_NOT_FOUND')
  })

  it('400 VALIDATION_ERROR when a default rule turns required but keeps its value', async () => {
    const client = makeClient({
      company_members: MEMBER,
      account_dimension_rules: { data: { id: RULE_ID, rule_type: 'default', value_id: VALUE_ID, dimension_id: DIM_ID }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ rule_type: 'required' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toMatchObject({ field: 'value_id', rule_type: 'required' })
    expect(client.calls.some((c) => c.method === 'update')).toBe(false)
  })

  it('200 pauses the rule', async () => {
    const client = makeClient({
      company_members: MEMBER,
      account_dimension_rules: [
        { data: { id: RULE_ID, rule_type: 'required', value_id: null, dimension_id: DIM_ID }, error: null },
        { data: rawRule({ is_active: false }), error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ is_active: false })
    expect(res.status).toBe(200)
    expect((await res.json()).data.rule).toMatchObject({ account_dimension_rule_id: RULE_ID, is_active: false })
    const update = client.calls.find((c) => c.table === 'account_dimension_rules' && c.method === 'update')
    expect(update?.args[0]).toEqual({ is_active: false })
  })
})

describe('DELETE /api/v1/companies/:companyId/dimensions/rules/:id', () => {
  const del = () => deleteRule(request(`${BASE}/${RULE_ID}`, { method: 'DELETE' }), ruleParams)

  it('404 DIMENSION_RULE_NOT_FOUND when nothing was deleted', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, account_dimension_rules: { data: null, error: null, count: 0 } }))
    const res = await del()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('DIMENSION_RULE_NOT_FOUND')
  })

  it('200 deletes the rule', async () => {
    const client = makeClient({ company_members: MEMBER, account_dimension_rules: { data: null, error: null, count: 1 } })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ deleted: true, account_dimension_rule_id: RULE_ID })
    const filters = client.calls.filter((c) => c.table === 'account_dimension_rules' && c.method === 'eq')
    expect(filters.map((c) => c.args)).toEqual([
      ['id', RULE_ID],
      ['company_id', COMPANY_ID],
    ])
  })
})
