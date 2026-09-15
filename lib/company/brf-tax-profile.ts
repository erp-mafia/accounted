import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { BrfPropertyFactsSchema, BrfTaxProfileSchema } from '@/lib/api/schemas'
import { hasPropertyIncomeExemption, resolveCompanyEntityType } from '@/lib/company/entity-type'

/**
 * Bostadsrättsförening facts the ledger does not hold.
 *
 * brf_property_facts: kvm upplåtna med bostadsrätt and hyresrätt, lokaler,
 * the number of apartments, taxeringsvärde, tomträtt, samfällighet and
 * whether an underhållsplan exists. The förvaltningsberättelse nyckeltal of
 * ÅRL 6 kap. 3 a § (årsavgift, skuldsättning, sparande and energikostnad per
 * kvadratmeter) and the kommunal fastighetsavgift (lag 2007:1398: per
 * bostadslägenhet, capped at a share of the taxeringsvärde) start from them.
 *
 * brf_tax_profiles: one row per taxation year stating whether the förening
 * is a privatbostadsföretag (IL 2 kap. 17 §). The test is that at least 60 %
 * of the activity, measured by the hyresvärde on the taxeringsvärde, consists
 * of providing homes to members (or member companies' employees). A
 * privatbostadsföretag is not taxed on income from its property (IL 39 kap.
 * 25 §); an oäkta förening is taxed like any ekonomisk förening plus
 * uttagsbeskattning of below-market member fees. The share is a fact the
 * board or its accountant computes from the taxeringsvärde split; Accounted
 * stores the input and the decision, never derives the decision from ledger
 * balances, because the statutory measure is hyresvärde, not revenue.
 */

export const PRIVATBOSTADSFORETAG_QUALIFIED_SHARE_MIN = 0.6

export type BrfErrorCode =
  | 'BRF_FORM_REQUIRED'
  | 'BRF_TAX_PROFILE_NOT_FOUND'
  | 'BRF_TAX_PROFILE_REQUIRED'

export class BrfError extends Error {
  readonly code: BrfErrorCode
  constructor(code: BrfErrorCode) {
    super(code)
    this.name = 'BrfError'
    this.code = code
  }
}

export interface BrfPropertyFactsRow {
  id: string
  company_id: string
  kvm_bostadsratt: number | string | null
  kvm_hyresratt: number | string | null
  kvm_lokaler: number | string | null
  /** K3 38.3 c: lokaler upplåtna med bostadsrätt, part of kvm_bostadsratt. */
  kvm_lokaler_bostadsratt: number | string | null
  antal_bostadslagenheter: number | null
  antal_lokaler: number | null
  taxeringsvarde: number | string | null
  taxeringsvarde_bostader: number | string | null
  taxeringsvarde_lokaler: number | string | null
  vardear: number | null
  tomtratt: boolean | null
  tomtratt_avgald_until: string | null
  /** K3 38.2: the day the tomträtt runs to. */
  tomtratt_expires_on: string | null
  samfallighet: string | null
  underhallsplan: boolean | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface BrfTaxProfileRow {
  id: string
  company_id: string
  fiscal_year: number
  privatbostadsforetag: boolean
  qualified_share: number | string | null
  assessed_on: string
  notes: string | null
  created_at: string
  updated_at: string
}

/** Throws BRF_FORM_REQUIRED unless the company is a bostadsrättsförening. */
export async function requireBrfForm(supabase: SupabaseClient, companyId: string): Promise<void> {
  const entityType = await resolveCompanyEntityType(supabase, companyId)
  if (!hasPropertyIncomeExemption(entityType)) {
    throw new BrfError('BRF_FORM_REQUIRED')
  }
}

/**
 * IL 2 kap. 17 §: the förening is a privatbostadsföretag when the qualified
 * share (hyresvärde of homes provided to members over the whole hyresvärde,
 * both on the taxeringsvärde) is at least 60 %. Pure: the caller supplies
 * the share as a fraction 0-1; null means "not computed" and is not a yes.
 */
export function qualifiesAsPrivatbostadsforetag(qualifiedShare: number | null | undefined): boolean {
  if (typeof qualifiedShare !== 'number' || Number.isNaN(qualifiedShare)) return false
  return qualifiedShare >= PRIVATBOSTADSFORETAG_QUALIFIED_SHARE_MIN
}

/**
 * The stored decision for a year, read as a fact. The board's answer wins
 * over the share (a share is optional evidence); a missing row is "unknown"
 * and callers that need an answer (the year-end tax step) treat unknown as a
 * blocker, never as äkta.
 */
export function isPrivatbostadsforetag(profile: Pick<BrfTaxProfileRow, 'privatbostadsforetag'> | null): boolean | null {
  if (!profile) return null
  return profile.privatbostadsforetag
}

export async function getPropertyFacts(
  supabase: SupabaseClient,
  companyId: string,
): Promise<BrfPropertyFactsRow | null> {
  const { data, error } = await supabase
    .from('brf_property_facts')
    .select('id, company_id, kvm_bostadsratt, kvm_hyresratt, kvm_lokaler, kvm_lokaler_bostadsratt, antal_bostadslagenheter, antal_lokaler, taxeringsvarde, taxeringsvarde_bostader, taxeringsvarde_lokaler, vardear, tomtratt, tomtratt_avgald_until, tomtratt_expires_on, samfallighet, underhallsplan, notes, created_at, updated_at')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return (data as BrfPropertyFactsRow | null) ?? null
}

export async function upsertPropertyFacts(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: z.infer<typeof BrfPropertyFactsSchema>,
): Promise<BrfPropertyFactsRow> {
  const { data, error } = await supabase
    .from('brf_property_facts')
    .upsert(
      {
        company_id: companyId,
        user_id: userId,
        kvm_bostadsratt: input.kvm_bostadsratt ?? null,
        kvm_hyresratt: input.kvm_hyresratt ?? null,
        kvm_lokaler: input.kvm_lokaler ?? null,
        kvm_lokaler_bostadsratt: input.kvm_lokaler_bostadsratt ?? null,
        antal_bostadslagenheter: input.antal_bostadslagenheter ?? null,
        antal_lokaler: input.antal_lokaler ?? null,
        taxeringsvarde: input.taxeringsvarde ?? null,
        taxeringsvarde_bostader: input.taxeringsvarde_bostader ?? null,
        taxeringsvarde_lokaler: input.taxeringsvarde_lokaler ?? null,
        vardear: input.vardear ?? null,
        tomtratt: input.tomtratt ?? null,
        tomtratt_avgald_until: input.tomtratt_avgald_until ?? null,
        tomtratt_expires_on: input.tomtratt_expires_on ?? null,
        samfallighet: input.samfallighet ?? null,
        underhallsplan: input.underhallsplan ?? null,
        notes: input.notes ?? null,
      },
      { onConflict: 'company_id' },
    )
    .select('id, company_id, kvm_bostadsratt, kvm_hyresratt, kvm_lokaler, kvm_lokaler_bostadsratt, antal_bostadslagenheter, antal_lokaler, taxeringsvarde, taxeringsvarde_bostader, taxeringsvarde_lokaler, vardear, tomtratt, tomtratt_avgald_until, tomtratt_expires_on, samfallighet, underhallsplan, notes, created_at, updated_at')
    .single()
  if (error) throw error
  return data as BrfPropertyFactsRow
}

export async function getTaxProfile(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYear: number,
): Promise<BrfTaxProfileRow | null> {
  const { data, error } = await supabase
    .from('brf_tax_profiles')
    .select('id, company_id, fiscal_year, privatbostadsforetag, qualified_share, assessed_on, notes, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('fiscal_year', fiscalYear)
    .maybeSingle()
  if (error) throw error
  return (data as BrfTaxProfileRow | null) ?? null
}

export async function listTaxProfiles(
  supabase: SupabaseClient,
  companyId: string,
): Promise<BrfTaxProfileRow[]> {
  const { data, error } = await supabase
    .from('brf_tax_profiles')
    .select('id, company_id, fiscal_year, privatbostadsforetag, qualified_share, assessed_on, notes, created_at, updated_at')
    .eq('company_id', companyId)
    .order('fiscal_year', { ascending: false })
  if (error) throw error
  return (data as BrfTaxProfileRow[] | null) ?? []
}

export async function upsertTaxProfile(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: z.infer<typeof BrfTaxProfileSchema>,
): Promise<BrfTaxProfileRow> {
  const { data, error } = await supabase
    .from('brf_tax_profiles')
    .upsert(
      {
        company_id: companyId,
        user_id: userId,
        fiscal_year: input.fiscal_year,
        privatbostadsforetag: input.privatbostadsforetag,
        qualified_share: input.qualified_share ?? null,
        assessed_on: input.assessed_on,
        notes: input.notes ?? null,
      },
      { onConflict: 'company_id,fiscal_year' },
    )
    .select('id, company_id, fiscal_year, privatbostadsforetag, qualified_share, assessed_on, notes, created_at, updated_at')
    .single()
  if (error) throw error
  return data as BrfTaxProfileRow
}
