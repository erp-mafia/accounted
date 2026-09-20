/**
 * Integration tests for GET/PATCH .../assets/{id}. The service layer is
 * mocked; the shared gates and the correction lock are exercised through the
 * real error classes so the status mapping (404, 409, 422) is what a client
 * will see.
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
  return {
    ...actual,
    getAsset: vi.fn(),
    updateAsset: vi.fn(),
    deleteNeverPostedAsset: vi.fn(),
    getAssetDeleteBlock: vi.fn(),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  getAsset,
  updateAsset,
  deleteNeverPostedAsset,
  getAssetDeleteBlock,
  AssetCorrectionBlockedError,
  AssetDeleteBlockedError,
  AssetNotFoundError,
} from '@/lib/bokslut/assets/asset-service'
import { GET, PATCH, DELETE } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ASSET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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

function getRequest(url: string): Request {
  return new Request(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

function patchRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'abcd1234-2222-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}

function deleteRequest(url: string, opts: { idempotencyKey?: string | null } = {}): Request {
  const headers: Record<string, string> = { Authorization: 'Bearer test-fixture-not-a-real-key' }
  if (opts.idempotencyKey !== null) {
    headers['Idempotency-Key'] = opts.idempotencyKey ?? 'abcd1234-3333-4abc-8def-1234567890ab'
  }
  return new Request(url, { method: 'DELETE', headers })
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

const routeParams = (id: string) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })
const url = (id: string) => `https://x.test/api/v1/companies/${COMPANY_ID}/assets/${id}`

beforeEach(() => {
  vi.clearAllMocks()
  mockServiceClient.mockReturnValue(makeSupabase())
})

describe('GET /api/v1/companies/{companyId}/assets/{id}', () => {
  beforeEach(() => withScopes(['reports:read']))

  it('returns 401 without an API key', async () => {
    mockValidate.mockResolvedValue(null)
    const res = await GET(new Request(url(ASSET_ID)), routeParams(ASSET_ID))
    expect(res.status).toBe(401)
  })

  it('returns 400 for a non-UUID id', async () => {
    const res = await GET(getRequest(url('not-a-uuid')), routeParams('not-a-uuid'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 ASSET_NOT_FOUND when the asset is not in this company', async () => {
    vi.mocked(getAsset).mockResolvedValue(null)
    const res = await GET(getRequest(url(ASSET_ID)), routeParams(ASSET_ID))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('returns the asset with has_posted_depreciation', async () => {
    vi.mocked(getAsset).mockResolvedValue(ASSET as never)
    mockServiceClient.mockReturnValue(
      makeSupabase({ depreciation_schedules: { data: [{ asset_id: ASSET_ID }], error: null } }),
    )
    const res = await GET(getRequest(url(ASSET_ID)), routeParams(ASSET_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ id: ASSET_ID, name: 'MacBook Pro 16"', has_posted_depreciation: true })
  })
})

describe('PATCH /api/v1/companies/{companyId}/assets/{id}', () => {
  beforeEach(() => {
    withScopes(['bookkeeping:write'])
    vi.mocked(getAsset).mockResolvedValue(ASSET as never)
  })

  it('returns 400 on an empty body', async () => {
    const res = await PATCH(patchRequest(url(ASSET_ID), {}), routeParams(ASSET_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(vi.mocked(updateAsset)).not.toHaveBeenCalled()
  })

  it('returns 404 when the asset does not exist', async () => {
    vi.mocked(getAsset).mockResolvedValue(null)
    const res = await PATCH(patchRequest(url(ASSET_ID), { name: 'Renamed' }), routeParams(ASSET_ID))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('returns 422 K3_REQUIRED_FOR_COMPONENTS for a K2 company', async () => {
    const res = await PATCH(
      patchRequest(url(ASSET_ID), { k3_components: [{ name: 'Skärm', cost: 32000, useful_life_months: 36 }] }),
      routeParams(ASSET_ID),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('K3_REQUIRED_FOR_COMPONENTS')
    expect(vi.mocked(updateAsset)).not.toHaveBeenCalled()
  })

  it('returns 400 INVALID_K3_COMPONENTS when components do not sum to the cost (K3 company)', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({ companies: { data: { accounting_framework: 'k3', entity_type: 'aktiebolag' }, error: null } }),
    )
    const res = await PATCH(
      patchRequest(url(ASSET_ID), { k3_components: [{ name: 'Skärm', cost: 1000, useful_life_months: 36 }] }),
      routeParams(ASSET_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVALID_K3_COMPONENTS')
    expect(vi.mocked(updateAsset)).not.toHaveBeenCalled()
  })

  it('maps ASSET_CORRECTION_BLOCKED from the service to 409', async () => {
    vi.mocked(updateAsset).mockRejectedValue(new AssetCorrectionBlockedError('depreciation_posted'))
    const res = await PATCH(patchRequest(url(ASSET_ID), { acquisition_cost: 30000 }), routeParams(ASSET_ID))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ASSET_CORRECTION_BLOCKED')
  })

  it('dry-run returns the merged row without writing', async () => {
    const res = await PATCH(
      patchRequest(`${url(ASSET_ID)}?dry_run=true`, { name: 'Renamed', useful_life_months: 48 }),
      routeParams(ASSET_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({ id: ASSET_ID, name: 'Renamed', useful_life_months: 48, acquisition_cost: 32000 })
    expect(vi.mocked(updateAsset)).not.toHaveBeenCalled()
  })

  it('updates the asset and returns the row', async () => {
    vi.mocked(updateAsset).mockResolvedValue({ ...ASSET, name: 'Renamed', notes: 'Serie C02' } as never)
    const res = await PATCH(patchRequest(url(ASSET_ID), { name: 'Renamed', notes: 'Serie C02' }), routeParams(ASSET_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(vi.mocked(updateAsset)).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, ASSET_ID, {
      name: 'Renamed',
      notes: 'Serie C02',
    })
    expect(body.data).toMatchObject({ id: ASSET_ID, name: 'Renamed', notes: 'Serie C02', has_posted_depreciation: false })
  })
})

describe('DELETE /api/v1/companies/{companyId}/assets/{id}', () => {
  beforeEach(() => withScopes(['bookkeeping:write']))

  it('returns 401 without an API key', async () => {
    mockValidate.mockResolvedValue(null)
    const res = await DELETE(new Request(url(ASSET_ID), { method: 'DELETE' }), routeParams(ASSET_ID))
    expect(res.status).toBe(401)
    expect(deleteNeverPostedAsset).not.toHaveBeenCalled()
  })

  it('returns 403 INSUFFICIENT_SCOPE for a read-only key', async () => {
    withScopes(['reports:read'])
    const res = await DELETE(deleteRequest(url(ASSET_ID)), routeParams(ASSET_ID))
    expect(res.status).toBe(403)
    expect(deleteNeverPostedAsset).not.toHaveBeenCalled()
  })

  it('returns 400 when the Idempotency-Key header is missing', async () => {
    const res = await DELETE(deleteRequest(url(ASSET_ID), { idempotencyKey: null }), routeParams(ASSET_ID))
    expect(res.status).toBe(400)
    expect(deleteNeverPostedAsset).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-UUID id', async () => {
    const res = await DELETE(deleteRequest(url('nope')), routeParams('nope'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 ASSET_NOT_FOUND when the row is not in this company', async () => {
    vi.mocked(deleteNeverPostedAsset).mockRejectedValue(new AssetNotFoundError())
    const res = await DELETE(deleteRequest(url(ASSET_ID)), routeParams(ASSET_ID))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('returns 409 ASSET_DELETE_BLOCKED once the row has reached the books', async () => {
    vi.mocked(deleteNeverPostedAsset).mockRejectedValue(
      new AssetDeleteBlockedError('depreciation_posted'),
    )
    const res = await DELETE(deleteRequest(url(ASSET_ID)), routeParams(ASSET_ID))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ASSET_DELETE_BLOCKED')
    expect(body.error.message_en).toContain('reached the books')
  })

  it('deletes a never-posted row and answers 204 with no body', async () => {
    vi.mocked(deleteNeverPostedAsset).mockResolvedValue(ASSET as never)
    const res = await DELETE(deleteRequest(url(ASSET_ID)), routeParams(ASSET_ID))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(deleteNeverPostedAsset).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, ASSET_ID)
  })

  it('dry-run answers 204 without deleting when the row is deletable', async () => {
    vi.mocked(getAsset).mockResolvedValue(ASSET as never)
    vi.mocked(getAssetDeleteBlock).mockResolvedValue(null)
    const res = await DELETE(deleteRequest(`${url(ASSET_ID)}?dry_run=true`), routeParams(ASSET_ID))
    expect(res.status).toBe(204)
    expect(deleteNeverPostedAsset).not.toHaveBeenCalled()
  })

  it('dry-run answers 409 ASSET_DELETE_BLOCKED for a disposed row', async () => {
    vi.mocked(getAsset).mockResolvedValue({ ...ASSET, disposed_at: '2026-06-30' } as never)
    vi.mocked(getAssetDeleteBlock).mockResolvedValue('disposed')
    const res = await DELETE(deleteRequest(`${url(ASSET_ID)}?dry_run=true`), routeParams(ASSET_ID))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ASSET_DELETE_BLOCKED')
    expect(deleteNeverPostedAsset).not.toHaveBeenCalled()
  })
})
