/**
 * Integration tests for POST .../assets/{id}/dispose. The disposal service is
 * mocked at the two entry points the route uses (preview for dry-run, dispose
 * for the commit) and the typed asset errors are thrown for real so the
 * status mapping is what a client will see.
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
  return { ...actual, previewAssetDisposal: vi.fn(), disposeAsset: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  previewAssetDisposal,
  disposeAsset,
  AssetNotFoundError,
  AssetDisposalBlockedError,
  AssetJamkningDataRequiredError,
} from '@/lib/bokslut/assets/asset-service'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ASSET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PERIOD_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

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

const PREVIEW = {
  asset: ASSET,
  fiscalPeriod: { id: PERIOD_ID, period_start: '2026-01-01', period_end: '2026-12-31' },
  plan: {
    lines: [
      { account_number: '1930', debit_amount: 12500, credit_amount: 0, line_description: 'Likvid' },
      { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
      { account_number: '1224', debit_amount: 0, credit_amount: 32000 },
      { account_number: '1229', debit_amount: 8000, credit_amount: 0 },
      { account_number: '7973', debit_amount: 14000, credit_amount: 0 },
    ],
    currentDepreciation: 5000,
    accumulatedDepreciation: 8000,
    proceedsGross: 12500,
    proceedsVat: 2500,
    vatTreatment: 'standard_25',
    gainOrLoss: -14000,
    jamkning: { amount: 0, direction: 'none' },
  },
}

const SALE = {
  disposal_type: 'sale',
  disposed_at: '2026-09-15',
  disposed_proceeds: 12500,
  vat_treatment: 'standard_25',
  fiscal_period_id: PERIOD_ID,
}

function postRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'abcd1234-3333-4abc-8def-1234567890ab',
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

const routeParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: ASSET_ID }) }
const URL_ = `https://x.test/api/v1/companies/${COMPANY_ID}/assets/${ASSET_ID}/dispose`

beforeEach(() => {
  vi.clearAllMocks()
  mockServiceClient.mockReturnValue(
    makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    }),
  )
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['bookkeeping:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/{companyId}/assets/{id}/dispose', () => {
  it('returns 401 on an invalid API key', async () => {
    mockValidate.mockResolvedValue({ error: 'invalid key', status: 401 })
    const res = await POST(postRequest(URL_, SALE), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 when a scrap carries proceeds', async () => {
    const res = await POST(
      postRequest(URL_, { ...SALE, disposal_type: 'scrap', vat_treatment: undefined, disposed_proceeds: 100 }),
      routeParams,
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(vi.mocked(disposeAsset)).not.toHaveBeenCalled()
  })

  it('returns 400 when a sale with proceeds has no vat_treatment', async () => {
    const res = await POST(postRequest(URL_, { ...SALE, vat_treatment: undefined }), routeParams)
    expect(res.status).toBe(400)
  })

  it('returns 404 ASSET_NOT_FOUND from the service', async () => {
    vi.mocked(disposeAsset).mockRejectedValue(new AssetNotFoundError())
    const res = await POST(postRequest(URL_, SALE), routeParams)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('ASSET_NOT_FOUND')
  })

  it('returns 409 ASSET_DISPOSAL_BLOCKED when later depreciation is posted', async () => {
    vi.mocked(disposeAsset).mockRejectedValue(new AssetDisposalBlockedError('later_depreciation_posted'))
    const res = await POST(postRequest(URL_, SALE), routeParams)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ASSET_DISPOSAL_BLOCKED')
  })

  it('returns 422 ASSET_JAMKNING_DATA_REQUIRED on dry-run too', async () => {
    vi.mocked(previewAssetDisposal).mockRejectedValue(new AssetJamkningDataRequiredError())
    const res = await POST(postRequest(`${URL_}?dry_run=true`, SALE), routeParams)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('ASSET_JAMKNING_DATA_REQUIRED')
    expect(vi.mocked(disposeAsset)).not.toHaveBeenCalled()
  })

  it('dry-run returns the plan lines and gain/loss without writing', async () => {
    vi.mocked(previewAssetDisposal).mockResolvedValue(PREVIEW as never)
    const res = await POST(postRequest(`${URL_}?dry_run=true`, SALE), routeParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      asset_name: 'MacBook Pro 16"',
      disposal_type: 'sale',
      proceeds_gross: 12500,
      proceeds_vat: 2500,
      accumulated_depreciation: 8000,
      book_value: 24000,
      gain_or_loss: -14000,
      posts_journal_entry: true,
    })
    expect(body.data.preview.lines).toHaveLength(5)
    expect(body.data.preview.lines[0]).toEqual({ account_number: '1930', debit: 12500, credit: 0, description: 'Likvid' })
    expect(vi.mocked(previewAssetDisposal)).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      ASSET_ID,
      expect.objectContaining({ disposal_type: 'sale', disposed_proceeds: 12500 }),
    )
    expect(vi.mocked(disposeAsset)).not.toHaveBeenCalled()
  })

  it('disposes the asset and returns the voucher reference', async () => {
    vi.mocked(disposeAsset).mockResolvedValue({
      asset: { ...ASSET, disposed_at: '2026-09-15', disposal_type: 'sale', disposed_proceeds: 12500, disposal_journal_entry_id: 'je-1' },
      disposal_entry: { id: 'je-1', voucher_number: 118 },
      gain_or_loss: -14000,
    } as never)
    const res = await POST(postRequest(URL_, SALE), routeParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(vi.mocked(disposeAsset)).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      ASSET_ID,
      expect.objectContaining({ disposal_type: 'sale', fiscal_period_id: PERIOD_ID }),
    )
    expect(body.data.asset).toMatchObject({
      id: ASSET_ID,
      disposed_at: '2026-09-15',
      disposal_type: 'sale',
      disposed_proceeds: 12500,
      has_posted_depreciation: true,
    })
    expect(body.data.disposal_entry).toEqual({ journal_entry_id: 'je-1', voucher_number: 118 })
    expect(body.data.gain_or_loss).toBe(-14000)
  })
})
