/**
 * GET /api/v1/companies/:companyId/capabilities: every module with its
 * status, reasons and resolution for one company. The rules are pinned in
 * lib/modules/__tests__/capabilities.test.ts; this suite covers the door:
 * auth, scope, an unreachable company, and one company with a mix of states.
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
import { MODULES } from '@/lib/modules/manifest'
import { createTableMockSupabase } from '@/tests/helpers'
import { GET as getCapabilities } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

type MockResult = { data?: unknown; error?: unknown }

/** Per-table answers; the grant rows come from the company_capability_grant_rows RPC. */
function makeSupabase(opts: { tables?: Record<string, MockResult>; grants?: MockResult }) {
  const { supabase } = createTableMockSupabase({
    ...(opts.tables ?? {}),
    'rpc:company_capability_grant_rows': opts.grants ?? { data: [] },
  })
  return supabase
}

const MEMBERSHIP: MockResult = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }

function makeRequest(opts: { auth?: boolean } = {}): Request {
  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/capabilities`, {
    method: 'GET',
    headers: opts.auth === false ? {} : { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

function call(request: Request) {
  return getCapabilities(request, { params: Promise.resolve({ companyId: COMPANY_ID }) })
}

const future = new Date(Date.now() + 86_400_000).toISOString()
const past = new Date(Date.now() - 86_400_000).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['companies:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/capabilities', () => {
  it('returns 401 without a bearer token', async () => {
    mockServiceClient.mockReturnValue(makeSupabase({}))
    const res = await call(makeRequest({ auth: false }))
    expect(res.status).toBe(401)
  })

  it('returns 403 for a key without companies:read', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeSupabase({ tables: { company_members: MEMBERSHIP } }))
    const res = await call(makeRequest())
    expect(res.status).toBe(403)
  })

  it('returns 404 when the caller is not a member of the company', async () => {
    mockServiceClient.mockReturnValue(makeSupabase({ tables: { company_members: { data: null, error: null } } }))
    const res = await call(makeRequest())
    expect(res.status).toBe(404)
  })

  it('returns 404 when the company row is gone', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({ tables: { company_members: MEMBERSHIP, companies: { data: null, error: null } } }),
    )
    const res = await call(makeRequest())
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns every module with a mix of statuses for one company', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({
        tables: {
          company_members: MEMBERSHIP,
          companies: { data: { jurisdiction: 'SE', ledger_currency: 'SEK', entity_type: 'enskild_firma' }, error: null },
          company_settings: { data: { entity_type: 'enskild_firma', pays_salaries: false }, error: null },
          company_capability_config: { data: [{ capability_key: 'bank_sync' }], error: null },
        },
        grants: {
          data: [
            { capability_key: 'ai', expires_at: null, source: 'stripe', team_id: null },
            { capability_key: 'bank_sync', expires_at: future, source: 'stripe', team_id: null },
            { capability_key: 'skatteverket', expires_at: past, source: 'trial', team_id: null },
          ],
          error: null,
        },
      }),
    )
    const res = await call(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.request_id).toMatch(/^req_/)
    expect(body.data.jurisdiction).toBe('SE')
    expect(body.data.ledger_currency).toBe('SEK')

    const modules = body.data.modules as Array<{ id: string; status: string; reasons: string[]; resolution: string | null }>
    expect(modules.map((m) => m.id)).toEqual(MODULES.map((m) => m.id))
    const byId = Object.fromEntries(modules.map((m) => [m.id, m]))

    expect(byId.platform).toMatchObject({ kind: 'kernel', status: 'active', reasons: [], resolution: null })
    expect(byId.ledger).toMatchObject({ kind: 'kernel', status: 'active', reasons: [], resolution: null })
    expect(byId.agent).toMatchObject({ status: 'active', reasons: [] })
    expect(byId.payroll).toMatchObject({ status: 'unsupported', reasons: ['unsupported_legal_form'] })
    expect(byId.expenses).toMatchObject({ status: 'active', reasons: [] })
    expect(byId['bank-feed']).toMatchObject({
      name: 'Bank feed',
      name_sv: 'Bankkoppling',
      depends_on: ['transactions'],
      status: 'off',
      reasons: ['disabled_by_company'],
      resolution: 'Bank feed is turned off for this company.',
    })
    expect(byId.payments).toMatchObject({ status: 'off', reasons: ['dependency_unavailable'] })
    expect(byId.skatteverket).toMatchObject({
      status: 'needs_plan',
      reasons: ['needs_plan'],
      resolution: 'Upgrade the plan to use Skatteverket.',
    })
    expect(byId.collections).toMatchObject({ status: 'needs_plan', reasons: ['needs_plan'] })
  })

  it('answers 500 rather than a wrong reason when the grants cannot be read', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({
        tables: {
          company_members: MEMBERSHIP,
          companies: { data: { jurisdiction: 'SE', ledger_currency: 'SEK', entity_type: 'aktiebolag' }, error: null },
          company_settings: { data: null, error: null },
          company_capability_config: { data: [], error: null },
        },
        grants: { data: null, error: { code: '57014', message: 'statement timeout' } },
      }),
    )
    const res = await call(makeRequest())
    expect(res.status).toBe(500)
  })
})
