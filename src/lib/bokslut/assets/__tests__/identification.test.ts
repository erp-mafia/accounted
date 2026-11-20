import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { AssetIdentificationSchema, identificationFieldsFor, listCarBenefits, updateAssetIdentification } from '../identification'

const COMPANY = 'company-1'
const BENEFIT = '11111111-1111-4111-8111-111111111111'

function ctxWith(tables: Parameters<typeof createTableMockSupabase>[0]) {
  const mock = createTableMockSupabase(tables)
  return { mock, ctx: { supabase: mock.supabase as unknown as SupabaseClient, companyId: COMPANY } }
}

beforeEach(() => vi.stubEnv('BOLAGET_COMPANY_IDS', COMPANY))
afterEach(() => vi.unstubAllEnvs())

describe('identificationFieldsFor', () => {
  it('gives a building its property fields and a vehicle its registration and car benefit', () => {
    expect(identificationFieldsFor('building')).toEqual(['fastighetsbeteckning', 'taxeringsvarde'])
    expect(identificationFieldsFor('vehicle')).toEqual(['registration_number', 'employee_benefit_id'])
    expect(identificationFieldsFor('computer')).toEqual([])
  })
})

describe('AssetIdentificationSchema', () => {
  it('refuses unknown fields and a negative taxeringsvärde', () => {
    expect(AssetIdentificationSchema.safeParse({ acquisition_cost: 1 }).success).toBe(false)
    expect(AssetIdentificationSchema.safeParse({ taxeringsvarde: -1 }).success).toBe(false)
    expect(AssetIdentificationSchema.safeParse({ taxeringsvarde: 1_250_000 }).success).toBe(true)
  })
})

describe('updateAssetIdentification', () => {
  it('is closed outside the rollout', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '')
    const { mock, ctx } = ctxWith({})
    expect(await updateAssetIdentification(ctx, 'a-1', { registration_number: 'ABC123' })).toEqual({ ok: false, code: 'COMMITMENTS_UNAVAILABLE' })
    expect(mock.tables()).toEqual([])
  })

  it('answers ASSET_NOT_FOUND for an asset the company does not have', async () => {
    const { ctx } = ctxWith({ assets: { data: null } })
    expect(await updateAssetIdentification(ctx, 'nope', { registration_number: 'ABC123' })).toEqual({ ok: false, code: 'ASSET_NOT_FOUND' })
  })

  it('refuses a vehicle field on a building, but lets it be cleared', async () => {
    const { mock, ctx } = ctxWith({ assets: [{ data: { id: 'a-1', category: 'building' } }, { data: { id: 'a-1', fastighetsbeteckning: null, taxeringsvarde: null, registration_number: null, employee_benefit_id: null } }] })
    expect(await updateAssetIdentification(ctx, 'a-1', { registration_number: 'ABC123' })).toEqual({
      ok: false,
      code: 'ASSET_IDENTIFICATION_INVALID',
      details: { fields: ['registration_number'] },
    })
    expect(mock.payloads('assets', 'update')).toEqual([])
  })

  it('links a vehicle to a car benefit of the company only', async () => {
    const { ctx } = ctxWith({ assets: { data: { id: 'a-1', category: 'vehicle' } }, employee_benefits: { data: { id: BENEFIT, benefit_type: 'meals' } } })
    expect(await updateAssetIdentification(ctx, 'a-1', { employee_benefit_id: BENEFIT })).toEqual({
      ok: false,
      code: 'COMMITMENTS_REFERENCE_NOT_FOUND',
      details: { field: 'employee_benefit_id' },
    })
  })

  it('saves a building\'s fastighetsbeteckning and taxeringsvärde rounded to the öre', async () => {
    const { mock, ctx } = ctxWith({
      assets: [
        { data: { id: 'a-1', category: 'building' } },
        { data: { id: 'a-1', fastighetsbeteckning: 'Uppsala Kungsängen 1:23', taxeringsvarde: '1250000.01', registration_number: null, employee_benefit_id: null } },
      ],
    })
    const outcome = await updateAssetIdentification(ctx, 'a-1', { fastighetsbeteckning: 'Uppsala Kungsängen 1:23', taxeringsvarde: 1250000.005 })
    expect(outcome).toEqual({
      ok: true,
      data: { asset_id: 'a-1', fastighetsbeteckning: 'Uppsala Kungsängen 1:23', taxeringsvarde: 1250000.01, registration_number: null, employee_benefit_id: null },
    })
    expect(mock.payloads('assets', 'update')[0]).toEqual({ fastighetsbeteckning: 'Uppsala Kungsängen 1:23', taxeringsvarde: 1250000.01 })
  })

  it('saves a vehicle\'s registration number in capitals with its car benefit', async () => {
    const { mock, ctx } = ctxWith({
      assets: [{ data: { id: 'a-1', category: 'vehicle' } }, { data: { id: 'a-1', fastighetsbeteckning: null, taxeringsvarde: null, registration_number: 'ABC123', employee_benefit_id: BENEFIT } }],
      employee_benefits: { data: { id: BENEFIT, benefit_type: 'car' } },
    })
    const outcome = await updateAssetIdentification(ctx, 'a-1', { registration_number: 'abc123', employee_benefit_id: BENEFIT })
    expect(outcome.ok).toBe(true)
    expect(mock.payloads('assets', 'update')[0]).toEqual({ registration_number: 'ABC123', employee_benefit_id: BENEFIT })
  })
})

describe('listCarBenefits', () => {
  it('lists the company\'s car benefits with the employee\'s name', async () => {
    const { ctx } = ctxWith({
      employee_benefits: { data: [{ id: BENEFIT, description: 'Volvo XC40', valid_from: '2026-01-01', valid_to: null, employees: { first_name: 'Anna', last_name: 'Svensson' } }] },
    })
    expect(await listCarBenefits(ctx)).toEqual({
      ok: true,
      data: { benefits: [{ employee_benefit_id: BENEFIT, description: 'Volvo XC40', employee_name: 'Anna Svensson', valid_from: '2026-01-01', valid_to: null }] },
    })
  })
})
