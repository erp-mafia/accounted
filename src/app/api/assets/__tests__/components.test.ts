import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'

const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/bokslut/assets/component-service', () => ({
  addAssetComponent: vi.fn(),
  updateAssetComponent: vi.fn(),
  deleteAssetComponent: vi.fn(),
  previewComponentReplacement: vi.fn(),
  replaceAssetComponent: vi.fn(),
}))

import {
  addAssetComponent,
  deleteAssetComponent,
  previewComponentReplacement,
  replaceAssetComponent,
  updateAssetComponent,
} from '@/lib/bokslut/assets/component-service'
import { POST as ADD } from '../[id]/components/route'
import { DELETE, PATCH } from '../[id]/components/[componentId]/route'
import { POST as REPLACE } from '../[id]/components/[componentId]/replace/route'

const assetParams = { params: Promise.resolve({ id: 'asset-1' }) }
const componentParams = { params: Promise.resolve({ id: 'asset-1', componentId: 'comp-1' }) }
const PERIOD = '11111111-1111-4111-8111-111111111111'
const notFound = Object.assign(new Error('ASSET_NOT_FOUND'), { code: 'ASSET_NOT_FOUND' })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

function unauthenticated() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

describe('POST /api/assets/[id]/components', () => {
  const body = { name: 'Hiss', cost: 50_000, useful_life_months: 300 }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await ADD(createMockRequest('/api/assets/asset-1/components', { method: 'POST', body }), assetParams)
    expect(res.status).toBe(401)
    expect(addAssetComponent).not.toHaveBeenCalled()
  })

  it('returns 400 for a component without a cost', async () => {
    const res = await ADD(
      createMockRequest('/api/assets/asset-1/components', { method: 'POST', body: { name: 'Hiss', useful_life_months: 300 } }),
      assetParams,
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the asset is not in the company', async () => {
    vi.mocked(addAssetComponent).mockRejectedValue(notFound)
    const res = await ADD(createMockRequest('/api/assets/asset-1/components', { method: 'POST', body }), assetParams)
    expect(res.status).toBe(404)
  })

  it('registers the component for the signed-in user', async () => {
    vi.mocked(addAssetComponent).mockResolvedValue({ id: 'asset-1' } as never)
    const res = await ADD(createMockRequest('/api/assets/asset-1/components', { method: 'POST', body }), assetParams)
    expect(res.status).toBe(200)
    expect(addAssetComponent).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'asset-1', body)
  })
})

describe('PATCH and DELETE /api/assets/[id]/components/[componentId]', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await PATCH(
      createMockRequest('/api/assets/asset-1/components/comp-1', { method: 'PATCH', body: { useful_life_months: 240 } }),
      componentParams,
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 for a non-integer life', async () => {
    const res = await PATCH(
      createMockRequest('/api/assets/asset-1/components/comp-1', { method: 'PATCH', body: { useful_life_months: 2.5 } }),
      componentParams,
    )
    expect(res.status).toBe(400)
    expect(updateAssetComponent).not.toHaveBeenCalled()
  })

  it('maps a posted basis to 409 ASSET_CORRECTION_BLOCKED', async () => {
    vi.mocked(updateAssetComponent).mockRejectedValue(
      Object.assign(new Error('blocked'), { code: 'ASSET_CORRECTION_BLOCKED' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(
        createMockRequest('/api/assets/asset-1/components/comp-1', { method: 'PATCH', body: { cost: 1 } }),
        componentParams,
      ),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ASSET_CORRECTION_BLOCKED')
  })

  it('changes the component', async () => {
    vi.mocked(updateAssetComponent).mockResolvedValue({ id: 'asset-1' } as never)
    const res = await PATCH(
      createMockRequest('/api/assets/asset-1/components/comp-1', { method: 'PATCH', body: { useful_life_months: 240 } }),
      componentParams,
    )
    expect(res.status).toBe(200)
    expect(updateAssetComponent).toHaveBeenCalledWith(supabase, 'company-1', 'asset-1', 'comp-1', { useful_life_months: 240 })
  })

  it('removes a component, 404 when it is unknown', async () => {
    vi.mocked(deleteAssetComponent).mockResolvedValueOnce({ id: 'asset-1' } as never)
    expect((await DELETE(createMockRequest('/api/assets/asset-1/components/comp-1', { method: 'DELETE' }), componentParams)).status).toBe(200)
    vi.mocked(deleteAssetComponent).mockRejectedValueOnce(
      Object.assign(new Error('ASSET_COMPONENT_NOT_FOUND'), { code: 'ASSET_COMPONENT_NOT_FOUND' }),
    )
    expect((await DELETE(createMockRequest('/api/assets/asset-1/components/comp-1', { method: 'DELETE' }), componentParams)).status).toBe(404)
  })
})

describe('POST /api/assets/[id]/components/[componentId]/replace', () => {
  const body = {
    replaced_at: '2026-06-30',
    fiscal_period_id: PERIOD,
    new_component: { name: 'Nytt tak', cost: 250_000, useful_life_months: 360 },
  }

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await REPLACE(createMockRequest('/x', { method: 'POST', body }), componentParams)
    expect(res.status).toBe(401)
    expect(replaceAssetComponent).not.toHaveBeenCalled()
  })

  it('returns 400 without a fiscal period', async () => {
    const res = await REPLACE(
      createMockRequest('/x', { method: 'POST', body: { replaced_at: '2026-06-30' } }),
      componentParams,
    )
    expect(res.status).toBe(400)
  })

  it('answers the plan on dry_run and posts nothing', async () => {
    vi.mocked(previewComponentReplacement).mockResolvedValue({
      asset: { name: 'Fastighet' },
      fiscalPeriod: { id: PERIOD },
      plan: {
        lines: [{ account_number: '1110', debit_amount: 0, credit_amount: 200_000, line_description: 'x' }],
        componentName: 'Tak',
        cost: 200_000,
        depreciationToDate: 0,
        accumulatedCleared: 40_000,
        carryingAmount: 160_000,
        newComponent: body.new_component,
      },
    } as never)
    const { status, body: json } = await parseJsonResponse<{ data: { carrying_amount_loss: number } }>(
      await REPLACE(createMockRequest('/x', { method: 'POST', body: { ...body, dry_run: true } }), componentParams),
    )
    expect(status).toBe(200)
    expect(json.data.carrying_amount_loss).toBe(160_000)
    expect(replaceAssetComponent).not.toHaveBeenCalled()
  })

  it('maps a blocked replacement to 409', async () => {
    vi.mocked(replaceAssetComponent).mockRejectedValue(
      Object.assign(new Error('year_depreciated'), { code: 'ASSET_COMPONENT_REPLACEMENT_BLOCKED' }),
    )
    const res = await REPLACE(createMockRequest('/x', { method: 'POST', body }), componentParams)
    expect(res.status).toBe(409)
  })

  it('answers a replacement its posting function refuses behind a lock as 400 PERIOD_LOCKED, not a 500', async () => {
    vi.mocked(replaceAssetComponent).mockRejectedValue(
      new BookkeepingDatabaseError(
        'commit_asset_component_replacement',
        'Cannot derecognise a component in a locked or closed fiscal period',
        '23514',
      ),
    )
    const { status, body: json } = await parseJsonResponse<{ error: { code: string } }>(
      await REPLACE(createMockRequest('/x', { method: 'POST', body }), componentParams),
    )
    expect(status).toBe(400)
    expect(json.error.code).toBe('PERIOD_LOCKED')
  })

  it('posts the replacement', async () => {
    vi.mocked(replaceAssetComponent).mockResolvedValue({
      asset: { id: 'asset-1' },
      entry: { id: 'je-1' },
      newComponentId: 'comp-2',
      plan: {},
    } as never)
    const { status, body: json } = await parseJsonResponse<{ data: { journal_entry_id: string; new_component_id: string } }>(
      await REPLACE(createMockRequest('/x', { method: 'POST', body }), componentParams),
    )
    expect(status).toBe(200)
    expect(json.data).toMatchObject({ journal_entry_id: 'je-1', new_component_id: 'comp-2' })
    expect(replaceAssetComponent).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'asset-1', 'comp-1', body)
  })
})
