/**
 * Tests for GET/PATCH /api/assets/[id].
 *
 * Exercises the routes through the real withRouteContext wrapper, mocking the
 * asset service and auth/company dependencies. The K3 component cross-sum
 * validation runs the REAL validateComponents so the regression case (body
 * changes acquisition_cost and k3_components together — sum must match the
 * NEW cost) is covered end to end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

// Keep DEFAULT_ACCOUNTS_BY_CATEGORY (and other pure exports) real: the routes
// resolve category-default accounts through it for the K2_EXCLUDED_ACCOUNT
// framework gate. Only the service functions that hit Supabase are mocked.
vi.mock('@/lib/bokslut/assets/asset-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bokslut/assets/asset-service')>()
  return {
    ...actual,
    createAsset: vi.fn(),
    listAssets: vi.fn(),
    getAsset: vi.fn(),
    updateAsset: vi.fn(),
  }
})

import { createAsset, getAsset, updateAsset } from '@/lib/bokslut/assets/asset-service'
import { GET, PATCH } from '../[id]/route'
import { POST } from '../route'

const mockGetAsset = vi.mocked(getAsset)
const mockUpdateAsset = vi.mocked(updateAsset)
const mockCreateAsset = vi.mocked(createAsset)
const routeParams = { params: Promise.resolve({ id: 'asset-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('GET /api/assets/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await GET(createMockRequest('/api/assets/asset-1'), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 404 when the asset does not exist', async () => {
    mockGetAsset.mockResolvedValue(null)

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/assets/asset-1'), routeParams)
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('ASSET_NOT_FOUND')
  })
})

describe('POST /api/assets', () => {
  it('rejects legacy per-asset tax depreciation methods with 400', async () => {
    const response = await POST(createMockRequest('/api/assets', {
      method: 'POST',
      body: {
        name: 'Maskin',
        category: 'machinery',
        acquisition_date: '2025-01-01',
        acquisition_cost: 100_000,
        useful_life_months: 60,
        depreciation_method: 'declining_balance_30',
      },
    }))

    expect(response.status).toBe(400)
  })

  it('creates a valid asset with ordinary linear depreciation', async () => {
    mockCreateAsset.mockResolvedValue({ id: 'asset-new', depreciation_method: 'linear' } as never)
    const response = await POST(createMockRequest('/api/assets', {
      method: 'POST',
      body: {
        name: 'Maskin',
        category: 'machinery',
        acquisition_date: '2025-01-01',
        acquisition_cost: 100_000,
        useful_life_months: 60,
        depreciation_method: 'linear',
      },
    }))

    expect(response.status).toBe(200)
    expect(mockCreateAsset).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ depreciation_method: 'linear' }),
    )
  })

  // K2 forbids only EGENUPPARBETADE immateriella tillgångar; an ACQUIRED one
  // (a bought licence, a trademark) is lawful, so the category defaults now
  // resolve to the acquired pair 1090/1099 for a non-K3 company and the gate
  // must let the create through. See
  // .claude/skills/swedish-year-end-closing/references/k2-vs-k3.md:24.
  it('lets a K2 company create an immaterial asset on the category defaults', async () => {
    enqueue({ data: { accounting_framework: 'k2' } })
    mockCreateAsset.mockResolvedValue({ id: 'asset-licence' } as never)

    const response = await POST(createMockRequest('/api/assets', {
      method: 'POST',
      body: {
        name: 'Programvarulicens',
        category: 'immaterial',
        acquisition_date: '2025-01-01',
        acquisition_cost: 100_000,
        useful_life_months: 60,
      },
    }))

    expect(response.status).toBe(200)
    // No accounts in the body: the service resolves 1090/1099 itself, so the
    // client never has to know the rule (asset-service.test.ts pins the pair).
    expect(mockCreateAsset).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ category: 'immaterial' }),
    )
    const [, , , input] = mockCreateAsset.mock.calls[0]
    expect(input.bas_asset_account).toBeUndefined()
    expect(input.bas_accumulated_account).toBeUndefined()
  })

  // Only a deliberate override onto an Ej K2 account is still unlawful.
  it.each([
    ['1010', '1039'],
    ['1011', '1039'],
    ['1012', '1039'],
    ['1018', '1039'],
    ['1019', '1039'],
    ['1081', '1039'],
  ])(
    'rejects a K2 company explicitly overriding onto %s with 422',
    async (assetAccount, accumulatedAccount) => {
      enqueue({ data: { accounting_framework: 'k2', entity_type: 'aktiebolag' } })

      const { status, body } = await parseJsonResponse<{
        error: { code: string; message: string }
      }>(
        await POST(createMockRequest('/api/assets', {
          method: 'POST',
          body: {
            name: 'Utvecklingsprojekt',
            category: 'immaterial',
            acquisition_date: '2025-01-01',
            acquisition_cost: 50_000,
            useful_life_months: 60,
            bas_asset_account: assetAccount,
            bas_accumulated_account: accumulatedAccount,
          },
        }))
      )

      expect(status).toBe(422)
      expect(body.error.code).toBe('K2_EXCLUDED_ACCOUNT')
      expect(body.error.message).toContain(assetAccount)
      // All six are kontogrupp 10 and the company is an AB preparing an
      // årsredovisning, so the punkt 10.4 citation applies.
      expect(body.error.message).toContain('BFNAR 2016:10 punkt 10.4')
      expect(mockCreateAsset).not.toHaveBeenCalled()
    },
  )

  // companies.accounting_framework is NOT NULL DEFAULT 'k2', so an enskild
  // firma runs into the same gate. It prepares a förenklat årsbokslut, not an
  // årsredovisning under BFNAR 2016:10, so the K2 citation would be a false
  // legal claim and "use K3 instead" an impossible remedy. The block stands;
  // the wording drops both and keeps the actionable 1090 remedy.
  it('rejects an enskild firma on 1010 without citing BFNAR 2016:10 or K3', async () => {
    enqueue({ data: { accounting_framework: 'k2', entity_type: 'enskild_firma' } })

    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en: string }
    }>(
      await POST(createMockRequest('/api/assets', {
        method: 'POST',
        body: {
          name: 'Utvecklingsprojekt',
          category: 'immaterial',
          acquisition_date: '2025-01-01',
          acquisition_cost: 50_000,
          useful_life_months: 60,
          bas_asset_account: '1010',
          bas_accumulated_account: '1039',
        },
      }))
    )

    expect(status).toBe(422)
    expect(body.error.code).toBe('K2_EXCLUDED_ACCOUNT')
    expect(body.error.message).toContain('1010')
    expect(body.error.message).not.toContain('BFNAR 2016:10')
    expect(body.error.message).not.toContain('10.4')
    expect(body.error.message).not.toContain('K3')
    expect(body.error.message_en).not.toContain('BFNAR 2016:10')
    expect(body.error.message_en).not.toContain('K3')
    // Still actionable: the lawful account, and what the system did.
    expect(body.error.message).toContain('1090')
    expect(body.error.message).toContain('anläggningsregistret')
    expect(mockCreateAsset).not.toHaveBeenCalled()
  })

  it('rejects a K2 company overriding the ACCUMULATED account onto 1019 with 422', async () => {
    enqueue({ data: { accounting_framework: 'k2' } })

    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await POST(createMockRequest('/api/assets', {
        method: 'POST',
        body: {
          name: 'Patent',
          category: 'immaterial',
          acquisition_date: '2025-01-01',
          acquisition_cost: 50_000,
          useful_life_months: 60,
          bas_asset_account: '1030',
          bas_accumulated_account: '1019',
        },
      }))
    )

    expect(status).toBe(422)
    expect(body.error.code).toBe('K2_EXCLUDED_ACCOUNT')
    expect(body.error.message).toContain('1019')
    expect(mockCreateAsset).not.toHaveBeenCalled()
  })

  // Switching regelverk drags in komponentavskrivning and uppskjuten skatt and
  // rewrites the whole årsredovisning: it is never the remedy for one account.
  // The rejection must also not assert which framework the company applies,
  // since the companies read behind it discards its error.
  it('does not tell the user to switch accounting framework in the rejection', async () => {
    enqueue({ data: { accounting_framework: 'k2' } })

    const { body } = await parseJsonResponse<{
      error: { message: string; message_en: string }
    }>(
      await POST(createMockRequest('/api/assets', {
        method: 'POST',
        body: {
          name: 'Utvecklingsprojekt',
          category: 'immaterial',
          acquisition_date: '2025-01-01',
          acquisition_cost: 50_000,
          useful_life_months: 60,
          bas_asset_account: '1010',
          bas_accumulated_account: '1039',
        },
      }))
    )

    expect(body.error.message).not.toContain('Byt regelverk')
    expect(body.error.message).not.toContain('Inställningar')
    expect(body.error.message).not.toContain('företaget tillämpar')
    expect(body.error.message_en).not.toContain('Switch the accounting framework')
    expect(body.error.message_en).not.toContain('Settings')
    // It points at the lawful account instead.
    expect(body.error.message).toContain('1090')
    expect(body.error.message_en).toContain('1090')
  })

  it('accepts a K2 company creating an immaterial asset on a purchased pair (1030/1039)', async () => {
    enqueue({ data: { accounting_framework: 'k2' } })
    mockCreateAsset.mockResolvedValue({ id: 'asset-patent' } as never)

    const response = await POST(createMockRequest('/api/assets', {
      method: 'POST',
      body: {
        name: 'Patent',
        category: 'immaterial',
        acquisition_date: '2025-01-01',
        acquisition_cost: 80_000,
        useful_life_months: 60,
        bas_asset_account: '1030',
        bas_accumulated_account: '1039',
      },
    }))

    expect(response.status).toBe(200)
    expect(mockCreateAsset).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ bas_asset_account: '1030' }),
    )
  })

  it('accepts a K3 company creating an immaterial asset on the 1010/1019 defaults', async () => {
    enqueue({ data: { accounting_framework: 'k3' } })
    mockCreateAsset.mockResolvedValue({ id: 'asset-dev' } as never)

    const response = await POST(createMockRequest('/api/assets', {
      method: 'POST',
      body: {
        name: 'Utvecklingsutgifter plattform',
        category: 'immaterial',
        acquisition_date: '2025-01-01',
        acquisition_cost: 100_000,
        useful_life_months: 60,
      },
    }))

    expect(response.status).toBe(200)
    expect(mockCreateAsset).toHaveBeenCalled()
  })
})

describe('PATCH /api/assets/[id]', () => {
  it('rejects legacy per-asset tax depreciation methods with 400', async () => {
    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: { depreciation_method: 'declining_balance_30' },
    })

    const { status } = await parseJsonResponse(await PATCH(req, routeParams))

    expect(status).toBe(400)
    expect(mockUpdateAsset).not.toHaveBeenCalled()
  })

  it('rejects an invalid body (non-positive acquisition_cost) with 400', async () => {
    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: { acquisition_cost: -5 },
    })

    const { status } = await parseJsonResponse(await PATCH(req, routeParams))

    expect(status).toBe(400)
    expect(mockUpdateAsset).not.toHaveBeenCalled()
  })

  it('rejects k3_components for a K2 company with 422', async () => {
    enqueue({ data: { accounting_framework: 'k2' } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetAsset.mockResolvedValue({ id: 'asset-1', acquisition_cost: 100000 } as any)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: {
        k3_components: [{ name: 'Stomme', cost: 100000, useful_life_months: 600 }],
      },
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(req, routeParams)
    )

    expect(status).toBe(422)
    expect(body.error.code).toBe('K3_REQUIRED_FOR_COMPONENTS')
    expect(mockUpdateAsset).not.toHaveBeenCalled()
  })

  it('validates the component sum against the NEW acquisition_cost when both change', async () => {
    // Regression: stored cost is 100 000 but the PATCH raises it to 120 000.
    // Components summing to 120 000 must pass — previously they were checked
    // against the stale stored cost and wrongly rejected.
    enqueue({ data: { accounting_framework: 'k3' } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetAsset.mockResolvedValue({ id: 'asset-1', acquisition_cost: 100000 } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUpdateAsset.mockResolvedValue({ id: 'asset-1', acquisition_cost: 120000 } as any)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: {
        acquisition_cost: 120000,
        k3_components: [
          { name: 'Stomme', cost: 90000, useful_life_months: 600 },
          { name: 'Tak', cost: 30000, useful_life_months: 240 },
        ],
      },
    })

    const { status } = await parseJsonResponse(await PATCH(req, routeParams))

    expect(status).toBe(200)
    expect(mockUpdateAsset).toHaveBeenCalled()
  })

  it('rejects components that sum to the OLD cost when the PATCH changes the cost', async () => {
    enqueue({ data: { accounting_framework: 'k3' } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetAsset.mockResolvedValue({ id: 'asset-1', acquisition_cost: 100000 } as any)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: {
        acquisition_cost: 120000,
        k3_components: [{ name: 'Stomme', cost: 100000, useful_life_months: 600 }],
      },
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(req, routeParams)
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVALID_K3_COMPONENTS')
    expect(mockUpdateAsset).not.toHaveBeenCalled()
  })

  it('rejects a K2 company patching the asset account onto 1010 with 422', async () => {
    enqueue({ data: { accounting_framework: 'k2', entity_type: 'aktiebolag' } })
    mockGetAsset.mockResolvedValue({
      id: 'asset-1',
      category: 'immaterial',
      bas_asset_account: '1030',
      bas_accumulated_account: '1039',
      bas_expense_account: '7813',
    } as never)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: { bas_asset_account: '1010' },
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await PATCH(req, routeParams)
    )

    expect(status).toBe(422)
    expect(body.error.code).toBe('K2_EXCLUDED_ACCOUNT')
    expect(body.error.message).toContain('1010')
    // AB on the companies row, so the K2 citation is the right one here.
    expect(body.error.message).toContain('BFNAR 2016:10 punkt 10.4')
    expect(mockUpdateAsset).not.toHaveBeenCalled()
  })

  it('rejects a K2 company recategorizing AND overriding onto 1010 with 422', async () => {
    // Explicit accounts suppress the realign in updateAsset(), so the gate has
    // to evaluate the override rather than the (now lawful) category defaults.
    enqueue({ data: { accounting_framework: 'k2' } })
    mockGetAsset.mockResolvedValue({
      id: 'asset-1',
      category: 'equipment',
      bas_asset_account: '1220',
      bas_accumulated_account: '1229',
      bas_expense_account: '7832',
    } as never)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: {
        category: 'immaterial',
        bas_asset_account: '1010',
        bas_accumulated_account: '1019',
      },
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await PATCH(req, routeParams)
    )

    expect(status).toBe(422)
    expect(body.error.code).toBe('K2_EXCLUDED_ACCOUNT')
    expect(body.error.message).toContain('1010')
    expect(mockUpdateAsset).not.toHaveBeenCalled()
  })

  // The Ej K2 flag also covers accounts that have nothing to do with
  // intangibles (uppskjuten skatt, verkligt värde, säkringsredovisning, ...).
  // PATCH can reach them: UpdateAssetSchema has no BAS range refinement, so an
  // override outside the category range hits this gate before updateAsset()
  // raises its range error. Those rejections must NOT claim punkt 10.4.
  it('rejects a K2 company patching onto 1370 without citing the intangible rule', async () => {
    enqueue({ data: { accounting_framework: 'k2', entity_type: 'aktiebolag' } })
    mockGetAsset.mockResolvedValue({
      id: 'asset-1',
      category: 'immaterial',
      bas_asset_account: '1030',
      bas_accumulated_account: '1039',
      bas_expense_account: '7813',
    } as never)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: { bas_asset_account: '1370' },
    })

    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en: string }
    }>(await PATCH(req, routeParams))

    expect(status).toBe(422)
    expect(body.error.code).toBe('K2_EXCLUDED_ACCOUNT')
    expect(body.error.message).toContain('1370')
    expect(body.error.message).toContain('Ej K2')
    expect(body.error.message).toContain('K3')
    expect(body.error.message).not.toContain('10.4')
    expect(body.error.message).not.toContain('egenupparbetade')
    expect(body.error.message_en).toContain('Ej K2')
    expect(body.error.message_en).not.toContain('10.4')
    expect(body.error.message_en).not.toContain('intangible')
    expect(mockUpdateAsset).not.toHaveBeenCalled()
  })

  // The concrete case this route used to break: a K2 aktiebolag bought a
  // software licence, first filed it as "Inventarier", and now recategorizes
  // it to "Immateriell tillgång" from a dialog that sends only the changed
  // field and has no account inputs. K2 forbids EGENUPPARBETADE intangibles
  // only, so this is lawful and the defaults must land on the acquired pair.
  it('lets a K2 company recategorize to immaterial (defaults land on 1090/1099)', async () => {
    enqueue({ data: { accounting_framework: 'k2' } })
    mockGetAsset.mockResolvedValue({
      id: 'asset-1',
      category: 'equipment',
      bas_asset_account: '1220',
      bas_accumulated_account: '1229',
      bas_expense_account: '7832',
    } as never)
    mockUpdateAsset.mockResolvedValue({
      id: 'asset-1',
      category: 'immaterial',
      bas_asset_account: '1090',
      bas_accumulated_account: '1099',
    } as never)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: { category: 'immaterial' },
    })

    const { status, body } = await parseJsonResponse<{
      data: { bas_asset_account: string; bas_accumulated_account: string }
    }>(await PATCH(req, routeParams))

    expect(status).toBe(200)
    expect(body.data.bas_asset_account).toBe('1090')
    expect(body.data.bas_accumulated_account).toBe('1099')
    // The route forwards the bare category patch: updateAsset realigns the
    // triple itself (asset-service.test.ts pins the realigned pair).
    expect(mockUpdateAsset).toHaveBeenCalledWith(supabase, 'company-1', 'asset-1', {
      category: 'immaterial',
    })
  })

  it('allows a K2 company moving a legacy 1010 asset onto a purchased pair', async () => {
    enqueue({ data: { accounting_framework: 'k2' } })
    mockGetAsset.mockResolvedValue({
      id: 'asset-1',
      category: 'immaterial',
      bas_asset_account: '1010',
      bas_accumulated_account: '1019',
      bas_expense_account: '7811',
    } as never)
    mockUpdateAsset.mockResolvedValue({ id: 'asset-1', bas_asset_account: '1030' } as never)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: { bas_asset_account: '1030', bas_accumulated_account: '1039' },
    })

    const { status } = await parseJsonResponse(await PATCH(req, routeParams))

    expect(status).toBe(200)
    expect(mockUpdateAsset).toHaveBeenCalled()
  })

  it('allows a K3 company patching the asset account onto 1010', async () => {
    enqueue({ data: { accounting_framework: 'k3' } })
    mockGetAsset.mockResolvedValue({
      id: 'asset-1',
      category: 'immaterial',
      bas_asset_account: '1030',
      bas_accumulated_account: '1039',
      bas_expense_account: '7813',
    } as never)
    mockUpdateAsset.mockResolvedValue({ id: 'asset-1', bas_asset_account: '1010' } as never)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: { bas_asset_account: '1010', bas_accumulated_account: '1019' },
    })

    const { status } = await parseJsonResponse(await PATCH(req, routeParams))

    expect(status).toBe(200)
    expect(mockUpdateAsset).toHaveBeenCalled()
  })

  it('skips the framework gate for patches that touch neither category nor accounts', async () => {
    // No company row enqueued and getAsset unmocked: if the gate ran anyway
    // it would resolve a null company (treated as K2) and 404 on the missing
    // asset. A 200 therefore proves the name-only patch never hit the gate,
    // which keeps legacy K2 assets already sitting on 1010 editable.
    mockUpdateAsset.mockResolvedValue({ id: 'asset-1', name: 'Nytt namn' } as never)

    const req = createMockRequest('/api/assets/asset-1', {
      method: 'PATCH',
      body: { name: 'Nytt namn' },
    })

    const { status } = await parseJsonResponse(await PATCH(req, routeParams))

    expect(status).toBe(200)
    expect(mockUpdateAsset).toHaveBeenCalled()
  })
})
