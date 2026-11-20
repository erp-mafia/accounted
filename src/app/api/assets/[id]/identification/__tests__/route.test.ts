import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/bokslut/assets/identification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/identification')>()),
  updateAssetIdentification: vi.fn(),
  listCarBenefits: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { listCarBenefits, updateAssetIdentification } from '@/lib/bokslut/assets/identification'
import { PATCH } from '../route'
import { GET as carBenefits } from '../../../car-benefits/route'

const supabase = {}
const params = (id: string) => ({ params: Promise.resolve({ id }) }) as never
const patch = (body: unknown) => createMockRequest('/api/assets/a-1/identification', { method: 'PATCH', body })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
})

describe('PATCH /api/assets/:id/identification', () => {
  it('returns 401 without a session', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as never)
    expect((await PATCH(patch({ registration_number: 'ABC123' }), params('a-1'))).status).toBe(401)
    expect(updateAssetIdentification).not.toHaveBeenCalled()
  })

  it('returns 400 for a field outside identification', async () => {
    expect((await PATCH(patch({ acquisition_cost: 1 }), params('a-1'))).status).toBe(400)
    expect(updateAssetIdentification).not.toHaveBeenCalled()
  })

  it('answers 404 for an asset the company does not have', async () => {
    vi.mocked(updateAssetIdentification).mockResolvedValue({ ok: false, code: 'ASSET_NOT_FOUND' })
    expect((await PATCH(patch({ registration_number: 'ABC123' }), params('nope'))).status).toBe(404)
  })

  it('saves the fields for the asset', async () => {
    const data = { asset_id: 'a-1', fastighetsbeteckning: null, taxeringsvarde: null, registration_number: 'ABC123', employee_benefit_id: null }
    vi.mocked(updateAssetIdentification).mockResolvedValue({ ok: true, data })
    const res = await PATCH(patch({ registration_number: 'ABC123' }), params('a-1'))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(data)
    expect(updateAssetIdentification).toHaveBeenCalledWith({ supabase, companyId: 'company-1' }, 'a-1', { registration_number: 'ABC123' })
  })
})

describe('GET /api/assets/car-benefits', () => {
  it('returns 401 without a session', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as never)
    expect((await carBenefits(createMockRequest('/api/assets/car-benefits'), { params: Promise.resolve({}) } as never)).status).toBe(401)
  })

  it('answers 404 outside the rollout, so the dialogs hide the fields', async () => {
    vi.mocked(listCarBenefits).mockResolvedValue({ ok: false, code: 'COMMITMENTS_UNAVAILABLE' })
    expect((await carBenefits(createMockRequest('/api/assets/car-benefits'), { params: Promise.resolve({}) } as never)).status).toBe(404)
  })

  it('lists the car benefits', async () => {
    vi.mocked(listCarBenefits).mockResolvedValue({ ok: true, data: { benefits: [] } })
    const res = await carBenefits(createMockRequest('/api/assets/car-benefits'), { params: Promise.resolve({}) } as never)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ benefits: [] })
  })
})
