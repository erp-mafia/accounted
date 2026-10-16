/**
 * GET /api/v1/api-key: the calling key's own grant.
 *
 * Runs the real handler through the real v1 wrapper with `validateApiKey`
 * and the service client mocked, so the tests cover the wrapper's
 * 'authenticated' tier (a valid key, no scope check) as well as the
 * per-company verdict the route derives from the gate's own rule.
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

import { OAUTH_MCP_KEY_NAME, validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET } from '../route'
import { toHandle } from '@/lib/handles'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const USER_ID = '930abb54-c5ef-4ae0-b274-30fb16e9a295'
const COMPANY_A = '8fd5b1f4-0000-4000-8000-00000000000a'
const COMPANY_B = '8fd5b1f4-0000-4000-8000-00000000000b'
const COMPANY_C = '8fd5b1f4-0000-4000-8000-00000000000c'
const companyHandle = (id: string) => toHandle('company', id)

type TableCall = { table: string; method: string; args: unknown[] }

// Every chained builder method returns the chain; awaiting it resolves to the
// configured { data, error } for the table. Calls are recorded per table.
function makeSupabase(
  byTable: Record<string, { data?: unknown; error?: unknown }>,
  calls: TableCall[] = [],
) {
  const buildChain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(byTable[table] ?? { data: null, error: null })
          }
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args })
            return buildChain(table)
          }
        },
      },
    )
  return { from: vi.fn((table: string) => buildChain(table)) }
}

function makeRequest(withKey = true): Request {
  return new Request('https://x.test/api/v1/api-key', {
    headers: withKey ? { Authorization: 'Bearer test-fixture-not-a-real-key' } : {},
  })
}

// Next.js 16 passes `{ params: undefined }` to a static route's handler.
type GetCtx = Parameters<typeof GET>[1]
const staticRouteContext = () => ({ params: undefined }) as unknown as GetCtx

function validKey(over: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    companyId: COMPANY_A,
    apiKeyId: 'ak_1',
    apiKeyName: 'Integration key',
    scopes: ['documents:write'],
    mode: 'live',
    unattendedCommitLimit: null,
    allowedCompanyIds: null,
    readOnlyCompanyIds: null,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue(validKey())
  mockServiceClient.mockReturnValue(makeSupabase({ company_members: { data: [], error: null } }))
})

describe('GET /api/v1/api-key: authentication', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await GET(makeRequest(false), staticRouteContext())
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
    expect(mockValidate).not.toHaveBeenCalled()
  })

  it('returns 401 for a key that does not validate', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    const res = await GET(makeRequest(), staticRouteContext())
    expect(res.status).toBe(401)
  })

  it('returns 429 for a rate-limited key', async () => {
    mockValidate.mockResolvedValue({ error: 'Rate limit exceeded', status: 429 })
    const res = await GET(makeRequest(), staticRouteContext())
    expect(res.status).toBe(429)
  })

  it('answers a key whatever its scopes: no INSUFFICIENT_SCOPE, even without companies:read', async () => {
    mockValidate.mockResolvedValue(validKey({ scopes: ['invoices:read'] }))
    const res = await GET(makeRequest(), staticRouteContext())
    expect(res.status).toBe(200)
    expect((await res.json()).data.scopes).toEqual(['invoices:read'])
  })
})

describe('GET /api/v1/api-key: the grant', () => {
  it('returns mode, scopes, company access and each reachable company with its write verdict', async () => {
    mockValidate.mockResolvedValue(
      validKey({
        scopes: ['companies:read', 'documents:write'],
        allowedCompanyIds: [COMPANY_A, COMPANY_B, COMPANY_C],
        // Stored case differs from the membership row: compared case-insensitively.
        readOnlyCompanyIds: [COMPANY_C.toUpperCase()],
      }),
    )
    mockServiceClient.mockReturnValue(
      makeSupabase({
        company_members: {
          data: [
            { company_id: COMPANY_A, role: 'owner', companies: { archived_at: null } },
            { company_id: COMPANY_B, role: 'viewer', companies: { archived_at: null } },
            { company_id: COMPANY_C, role: 'admin', companies: { archived_at: null } },
          ],
          error: null,
        },
      }),
    )

    const res = await GET(makeRequest(), staticRouteContext())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      mode: 'live',
      scopes: ['companies:read', 'documents:write'],
      company_access: 'allowlist',
      // Each company carries its typed handle (lib/handles) beside the unchanged id.
      companies: [
        { id: COMPANY_A, handle: companyHandle(COMPANY_A), role: 'owner', access: 'read_write', read_only_code: null },
        { id: COMPANY_B, handle: companyHandle(COMPANY_B), role: 'viewer', access: 'read_only', read_only_code: 'ROLE_READ_ONLY' },
        { id: COMPANY_C, handle: companyHandle(COMPANY_C), role: 'admin', access: 'read_only', read_only_code: 'CONNECTION_READ_ONLY' },
      ],
    })
    expect(body.meta.request_id).toMatch(/^req_/)
  })

  it('names the role when a viewer membership is also a read-only connection, like the gate does', async () => {
    mockValidate.mockResolvedValue(
      validKey({ allowedCompanyIds: [COMPANY_A], readOnlyCompanyIds: [COMPANY_A] }),
    )
    mockServiceClient.mockReturnValue(
      makeSupabase({ company_members: { data: [{ company_id: COMPANY_A, role: 'viewer' }], error: null } }),
    )

    const body = await (await GET(makeRequest(), staticRouteContext())).json()
    expect(body.data.companies[0].read_only_code).toBe('ROLE_READ_ONLY')
  })

  it('reads live, non-archived memberships of the key user only, with no allowlist filter for an unrestricted key', async () => {
    const calls: TableCall[] = []
    mockServiceClient.mockReturnValue(makeSupabase({ company_members: { data: [], error: null } }, calls))

    const res = await GET(makeRequest(), staticRouteContext())
    expect(res.status).toBe(200)
    expect((await res.json()).data.company_access).toBe('all_memberships')

    expect(calls).toContainEqual({ table: 'company_members', method: 'eq', args: ['user_id', USER_ID] })
    expect(calls).toContainEqual({ table: 'company_members', method: 'is', args: ['companies.archived_at', null] })
    // The archived filter must drop the membership row, not just null its embed.
    const select = calls.find((c) => c.method === 'select')
    expect(String(select?.args[0])).toContain('!inner')
    expect(calls.some((c) => c.method === 'in')).toBe(false)
  })

  it('narrows the memberships to the allowlist for a restricted key', async () => {
    const calls: TableCall[] = []
    mockValidate.mockResolvedValue(validKey({ allowedCompanyIds: [COMPANY_A] }))
    mockServiceClient.mockReturnValue(makeSupabase({ company_members: { data: [], error: null } }, calls))

    await GET(makeRequest(), staticRouteContext())
    expect(calls).toContainEqual({ table: 'company_members', method: 'in', args: ['company_id', [COMPANY_A]] })
  })

  it('reports a test key as mode test and marks the response like every test-key response', async () => {
    mockValidate.mockResolvedValue(validKey({ mode: 'test' }))
    const res = await GET(makeRequest(), staticRouteContext())
    expect(res.status).toBe(200)
    expect((await res.json()).data.mode).toBe('test')
    expect(res.headers.get('X-Gnubok-Mode')).toBe('test')
  })

  it('answers a key issued through MCP OAuth the same way', async () => {
    mockValidate.mockResolvedValue(validKey({ apiKeyName: OAUTH_MCP_KEY_NAME, scopes: ['documents:read'] }))
    mockServiceClient.mockReturnValue(
      makeSupabase({ company_members: { data: [{ company_id: COMPANY_A, role: 'member' }], error: null } }),
    )

    const res = await GET(makeRequest(), staticRouteContext())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.companies).toEqual([
      { id: COMPANY_A, handle: companyHandle(COMPANY_A), role: 'member', access: 'read_write', read_only_code: null },
    ])
  })

  it('returns 500 INTERNAL_ERROR when the membership read fails', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({ company_members: { data: null, error: { message: 'boom' } } }),
    )
    const res = await GET(makeRequest(), staticRouteContext())
    expect(res.status).toBe(500)
  })
})
