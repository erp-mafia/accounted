/**
 * Integration tests for GET /api/v1/operations/:id.
 *
 * The URL carries no companyId: the route resolves the company from the
 * operation row, then runs the wrapper's company gate against it. These tests
 * pin that the gate is the same one a /companies/{companyId}/... URL gets:
 * membership, the key's company allowlist, and (for reads) nothing more.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
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
import { GET as getOperationRoute } from '../route'

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

const USER_ID = 'user-1'
const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_COMPANY_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const OPERATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const OPERATION_ROW = {
  id: OPERATION_ID,
  company_id: COMPANY_ID,
  user_id: USER_ID,
  operation_type: 'fiscal_periods.year_end',
  status: 'succeeded',
  started_at: '2026-05-12T10:01:23Z',
  completed_at: '2026-05-12T10:01:48Z',
  params: {},
  progress: { phase: 'committed', current: 1, total: 1 },
  result: { journal_entries_created: 4 },
  error: null,
  created_at: '2026-05-12T10:01:20Z',
  updated_at: '2026-05-12T10:01:48Z',
}

function keyWith(extra: Record<string, unknown> = {}) {
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: OTHER_COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Poller',
    scopes: ['operations:read'],
    mode: 'live',
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
    ...extra,
  })
}

function supabaseWith(membership: { company_id: string; role: string } | null) {
  const client = makeFlexibleSupabase({
    operations: [
      { data: { company_id: COMPANY_ID }, error: null }, // company lookup by id
      { data: OPERATION_ROW, error: null }, // getOperation, company-scoped
    ],
    company_members: { data: membership, error: null },
  })
  mockServiceClient.mockReturnValue(client)
  return client
}

function get(id = OPERATION_ID, headers: Record<string, string> = { Authorization: 'Bearer gnubok_sk_x' }) {
  return getOperationRoute(new Request(`https://x.test/api/v1/operations/${id}`, { headers }), {
    params: Promise.resolve({ id }),
  })
}

function operationReads(client: ReturnType<typeof makeFlexibleSupabase>): number {
  return client.from.mock.calls.filter(([t]) => t === 'operations').length
}

beforeEach(() => {
  vi.clearAllMocks()
  keyWith()
})

describe('GET /api/v1/operations/:id', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await get(OPERATION_ID, {})
    expect(res.status).toBe(401)
  })

  it('returns 400 VALIDATION_ERROR for a non-UUID id', async () => {
    supabaseWith({ company_id: COMPANY_ID, role: 'owner' })
    const res = await get('not-a-uuid')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 for an unknown operation id', async () => {
    const client = makeFlexibleSupabase({ operations: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await get()
    expect(res.status).toBe(404)
    expect((await res.json()).error.details).toEqual({ resource: 'operation' })
  })

  it('returns the operation for a member with an unrestricted key', async () => {
    supabaseWith({ company_id: COMPANY_ID, role: 'owner' })
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.operation_id).toBe(OPERATION_ID)
    expect(body.data.status).toBe('succeeded')
  })

  it('returns 404 for a non-member, shaped like an unknown id', async () => {
    const client = supabaseWith(null)
    const res = await get()
    expect(res.status).toBe(404)
    expect((await res.json()).error.details).toEqual({ resource: 'operation' })
    expect(operationReads(client)).toBe(1)
  })

  it('returns 404 for an operation of a member company outside the key allowlist, shaped like an unknown id', async () => {
    keyWith({ allowedCompanyIds: [OTHER_COMPANY_ID] })
    const client = supabaseWith({ company_id: COMPANY_ID, role: 'owner' })

    const res = await get()

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.details).toEqual({ resource: 'operation' })
    // The operation body was never read.
    expect(operationReads(client)).toBe(1)
  })

  it('returns the operation for a company inside the key allowlist', async () => {
    keyWith({ allowedCompanyIds: [OTHER_COMPANY_ID, COMPANY_ID] })
    supabaseWith({ company_id: COMPANY_ID, role: 'owner' })
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data.operation_id).toBe(OPERATION_ID)
  })

  it('lets a read-only company connection and a viewer membership poll (a read)', async () => {
    keyWith({ allowedCompanyIds: [COMPANY_ID], readOnlyCompanyIds: [COMPANY_ID] })
    supabaseWith({ company_id: COMPANY_ID, role: 'viewer' })
    const res = await get()
    expect(res.status).toBe(200)
  })
})
