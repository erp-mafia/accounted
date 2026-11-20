import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { roundOre } from '@/lib/money'
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'
import type { OperationOutcome } from '@/lib/operations/types'
import type { AssetCategory } from '@/types'

/**
 * What identifies a building or a vehicle in the asset register (BFNAR
 * 2013:2 punkt 4.5, identifieringsuppgifter): a building's
 * fastighetsbeteckning and its latest taxeringsvärde, a vehicle's
 * registration number and the bilförmån (employee_benefits) it is used for.
 * Registered beside the depreciation basis and never part of it, so it
 * stays editable after depreciation and disposal. Behind the Bolaget
 * rollout (BOLAGET_COMPANY_IDS).
 */
export const AssetIdentificationSchema = z
  .object({
    fastighetsbeteckning: z.string().trim().max(120).nullish(),
    taxeringsvarde: z.number().nonnegative().max(100_000_000_000).nullish(),
    registration_number: z.string().trim().max(20).nullish(),
    employee_benefit_id: z.string().uuid().nullish(),
  })
  .strict()
export type AssetIdentificationInput = z.infer<typeof AssetIdentificationSchema>

export interface AssetIdentification {
  asset_id: string
  fastighetsbeteckning: string | null
  taxeringsvarde: number | null
  registration_number: string | null
  employee_benefit_id: string | null
}

const BUILDING_FIELDS = ['fastighetsbeteckning', 'taxeringsvarde'] as const
const VEHICLE_FIELDS = ['registration_number', 'employee_benefit_id'] as const

/** The fields a category may carry; the others may only be cleared. */
export function identificationFieldsFor(category: AssetCategory): readonly string[] {
  if (category === 'building') return BUILDING_FIELDS
  if (category === 'vehicle') return VEHICLE_FIELDS
  return []
}

export async function updateAssetIdentification(
  ctx: { supabase: SupabaseClient; companyId: string },
  assetId: string,
  input: AssetIdentificationInput,
): Promise<OperationOutcome<AssetIdentification>> {
  if (!commitmentsEnabledFor(ctx.companyId)) return { ok: false, code: 'COMMITMENTS_UNAVAILABLE' }
  const { data: asset, error } = await ctx.supabase
    .from('assets')
    .select('id, category')
    .eq('company_id', ctx.companyId)
    .eq('id', assetId)
    .maybeSingle()
  if (error) throw error
  if (!asset) return { ok: false, code: 'ASSET_NOT_FOUND' }
  const allowed = identificationFieldsFor((asset as { category: AssetCategory }).category)
  const offending = Object.entries(input).filter(([field, value]) => value != null && value !== '' && !allowed.includes(field))
  if (offending.length > 0) return { ok: false, code: 'ASSET_IDENTIFICATION_INVALID', details: { fields: offending.map(([f]) => f) } }

  if (input.employee_benefit_id) {
    const { data: benefit, error: benefitError } = await ctx.supabase
      .from('employee_benefits')
      .select('id, benefit_type')
      .eq('company_id', ctx.companyId)
      .eq('id', input.employee_benefit_id)
      .maybeSingle()
    if (benefitError) throw benefitError
    if (!benefit || (benefit as { benefit_type: string }).benefit_type !== 'car') {
      return { ok: false, code: 'COMMITMENTS_REFERENCE_NOT_FOUND', details: { field: 'employee_benefit_id' } }
    }
  }

  // Undefined leaves a column alone; a blank text clears it.
  const fastighetsbeteckning = input.fastighetsbeteckning === undefined ? undefined : input.fastighetsbeteckning || null
  const taxeringsvarde = input.taxeringsvarde === undefined ? undefined : input.taxeringsvarde == null ? null : roundOre(input.taxeringsvarde)
  const registrationNumber = input.registration_number === undefined ? undefined : input.registration_number ? input.registration_number.toUpperCase() : null
  const employeeBenefitId = input.employee_benefit_id === undefined ? undefined : input.employee_benefit_id ?? null

  const { data, error: updateError } = await ctx.supabase
    .from('assets')
    .update({
      fastighetsbeteckning,
      taxeringsvarde,
      registration_number: registrationNumber,
      employee_benefit_id: employeeBenefitId,
    })
    .eq('company_id', ctx.companyId)
    .eq('id', assetId)
    .select('id, fastighetsbeteckning, taxeringsvarde, registration_number, employee_benefit_id')
    .single()
  if (updateError) throw updateError
  const row = data as { id: string; fastighetsbeteckning: string | null; taxeringsvarde: number | string | null; registration_number: string | null; employee_benefit_id: string | null }
  return {
    ok: true,
    data: {
      asset_id: row.id,
      fastighetsbeteckning: row.fastighetsbeteckning,
      taxeringsvarde: row.taxeringsvarde == null ? null : Number(row.taxeringsvarde),
      registration_number: row.registration_number,
      employee_benefit_id: row.employee_benefit_id,
    },
  }
}

export interface CarBenefitOption {
  employee_benefit_id: string
  description: string
  employee_name: string | null
  valid_from: string
  valid_to: string | null
}

/** The company's bilförmåner a vehicle can be linked to. */
export async function listCarBenefits(ctx: { supabase: SupabaseClient; companyId: string }): Promise<OperationOutcome<{ benefits: CarBenefitOption[] }>> {
  if (!commitmentsEnabledFor(ctx.companyId)) return { ok: false, code: 'COMMITMENTS_UNAVAILABLE' }
  const { data, error } = await ctx.supabase
    .from('employee_benefits')
    .select('id, description, valid_from, valid_to, employees(first_name, last_name)')
    .eq('company_id', ctx.companyId)
    .eq('benefit_type', 'car')
    .order('valid_from', { ascending: false })
    .limit(200)
  if (error) throw error
  const rows = (data ?? []) as unknown as Array<{
    id: string
    description: string
    valid_from: string
    valid_to: string | null
    employees: { first_name: string | null; last_name: string | null } | Array<{ first_name: string | null; last_name: string | null }> | null
  }>
  return {
    ok: true,
    data: {
      benefits: rows.map((r) => {
        const employee = Array.isArray(r.employees) ? r.employees[0] : r.employees
        const name = [employee?.first_name, employee?.last_name].filter(Boolean).join(' ').trim()
        return { employee_benefit_id: r.id, description: r.description, employee_name: name || null, valid_from: r.valid_from, valid_to: r.valid_to }
      }),
    },
  }
}
