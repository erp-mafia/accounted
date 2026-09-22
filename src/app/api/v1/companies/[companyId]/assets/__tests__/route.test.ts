/**
 * Integration tests for GET/POST .../assets (anläggningsregister on the v1
 * door). The service layer is mocked; the shared framework gates run for
 * real against a table-keyed Supabase mock so the K3/K2 refusals are
 * exercised end to end.
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
vi.mock('@/lib/bokslut/assets/asset-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bokslut/assets/asset-service')>(
    '@/lib/bokslut/assets/asset-service',
  )
  return { ...actual, listAssets: vi.fn(), createAsset: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { listAssets, createAsset } from '@/lib/bokslut/assets/asset-service'
import { GET, POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ASSET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_ASSET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const ASSET = {
  id: ASSET_ID,
  user_id: 'user-1',
  company_id: COMPANY_ID,
  name: 'MacBook Pro 16"',
  category: 'computer',
  acquisition_date: '2026-03-01',
  acquisition_cost: 32000,
  salvage_value: 0,
  useful_life_months: 36,
  depreciation_method: 'linear',
  bas_asset_account: '1224',
  bas_accumulated_account: '1229',
  bas_expense_account: '7832',
  restvarde_target: null,
  disposed_at: null,
  disposed_proceeds: null,
  disposal_type: null,
  disposal_journal_entry_id: null,
  disposed_proceeds_vat: 0,
  disposed_vat_treatment: null,
  jamkning_amount: 0,
  jamkning_remaining_months: null,
  jamkning_total_months: null,
  jamkning_original_input_vat: null,
  k3_components: null,
  notes: null,
  created_at: '2026-03-01T09:12:00.000Z',
  updated_at: '2026-03-01T09:12:00.000Z',
}

function getRequest(url: string, withAuth = true): Request {
  return new Request(url, {
    method: 'GET',
    headers: withAuth ? { Authorization: 'Bearer test-fixture-not-a-real-key' } : {},
  })
}

function postRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'abcd1234-1111-4abc-8def-1234567890ab',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
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

function makeSupabase(extra: Record<string, MockResult | MockResult[]> = {}) {
  return makeFlexibleSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    companies: { data: { accounting_framework: 'k2', entity_type: 'aktiebolag' }, error: null },
    depreciation_schedules: { data: [], error: null },
    ...extra,
  })
}

function withScopes(scopes: string[]) {
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes,
    mode: 'live',
  })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const LIST_URL = `https://x.test/api/v1/companies/${COMPANY_ID}/assets`

beforeEach(() => {
  vi.clearAllMocks()
  mockServiceClient.mockReturnValue(makeSupabase())
})

describe('GET /api/v1/companies/{companyId}/assets', () => {
  beforeEach(() => withScopes(['reports:read']))

  it('returns 401 without an API key', async () => {
    mockValidate.mockResolvedValue(null)
    const res = await GET(getRequest(LIST_URL, false), params)
    expect(res.status).toBe(401)
  })

  it('returns 403 without reports:read', async () => {
    withScopes(['invoices:read'])
    const res = await GET(getRequest(LIST_URL), params)
    expect(res.status).toBe(403)
  })

  it('returns 400 on an invalid active_only value', async () => {
    const res = await GET(getRequest(`${LIST_URL}?active_only=banana`), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('lists the register with has_posted_depreciation per asset', async () => {
    vi.mocked(listAssets).mockResolvedValue([
      ASSET,
      { ...ASSET, id: OTHER_ASSET_ID, name: 'Truck', category: 'vehicle', bas_asset_account: '1226' },
    ] as never)
    mockServiceClient.mockReturnValue(
      makeSupabase({ depreciation_schedules: { data: [{ asset_id: OTHER_ASSET_ID }], error: null } }),
    )

    const res = await GET(getRequest(`${LIST_URL}?active_only=true`), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(vi.mocked(listAssets)).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, { activeOnly: true })
    expect(body.data.assets).toHaveLength(2)
    expect(body.data.assets[0]).toMatchObject({
      id: ASSET_ID,
      name: 'MacBook Pro 16"',
      category: 'computer',
      acquisition_cost: 32000,
      bas_asset_account: '1224',
      has_posted_depreciation: false,
      disposed_at: null,
    })
    expect(body.data.assets[1]).toMatchObject({ id: OTHER_ASSET_ID, has_posted_depreciation: true })
    expect(body.meta.request_id).toMatch(/^req_/)
  })
})

describe('POST /api/v1/companies/{companyId}/assets', () => {
  const validBody = {
    name: 'MacBook Pro 16"',
    category: 'computer',
    acquisition_date: '2026-03-01',
    acquisition_cost: 32000,
    useful_life_months: 36,
  }

  beforeEach(() => withScopes(['bookkeeping:write']))

  it('returns 401 on an invalid API key', async () => {
    mockValidate.mockResolvedValue({ error: 'invalid key', status: 401 })
    const res = await POST(postRequest(LIST_URL, validBody), params)
    expect(res.status).toBe(401)
  })

  it('rejects requests without an Idempotency-Key header', async () => {
    const req = new Request(LIST_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-fixture-not-a-real-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    const res = await POST(req, params)
    expect(res.status).toBe(400)
    expect(vi.mocked(createAsset)).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR on a non-positive acquisition cost', async () => {
    const res = await POST(postRequest(LIST_URL, { ...validBody, acquisition_cost: 0 }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(vi.mocked(createAsset)).not.toHaveBeenCalled()
  })

  it('returns 400 when an account override sits outside the category range', async () => {
    const res = await POST(postRequest(LIST_URL, { ...validBody, bas_asset_account: '1110' }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 422 K3_REQUIRED_FOR_COMPONENTS for a K2 company sending k3_components', async () => {
    const res = await POST(
      postRequest(LIST_URL, {
        ...validBody,
        k3_components: [{ name: 'Skärm', cost: 32000, useful_life_months: 36 }],
      }),
      params,
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('K3_REQUIRED_FOR_COMPONENTS')
    expect(body.error.details.message_en).toMatch(/K3/)
    expect(vi.mocked(createAsset)).not.toHaveBeenCalled()
  })

  it('dry-run returns the resolved account triple without writing', async () => {
    const res = await POST(postRequest(`${LIST_URL}?dry_run=true`, validBody), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      name: 'MacBook Pro 16"',
      bas_asset_account: '1224',
      bas_accumulated_account: '1229',
      bas_expense_account: '7832',
      depreciation_method: 'linear',
      salvage_value: 0,
    })
    expect(vi.mocked(createAsset)).not.toHaveBeenCalled()
  })

  it('creates the asset and returns 201 with the register row', async () => {
    vi.mocked(createAsset).mockResolvedValue(ASSET as never)
    const res = await POST(postRequest(LIST_URL, validBody), params)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(vi.mocked(createAsset)).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ name: 'MacBook Pro 16"', category: 'computer', acquisition_cost: 32000 }),
    )
    expect(body.data).toMatchObject({
      id: ASSET_ID,
      name: 'MacBook Pro 16"',
      has_posted_depreciation: false,
      bas_asset_account: '1224',
    })
  })
})
