/**
 * Persistence for the annual-report compliance profile.
 *
 * Error contract: Supabase errors are rethrown untouched, exactly as
 * `lib/articles/validate-revenue-account.ts` does. Re-wrapping them in a plain
 * `new Error(...)` kept only `.message` and dropped `.code`, so `errorResponse()`
 * could no longer see the SQLSTATE and mapped every constraint failure on this
 * table to INTERNAL_ERROR / 500. The reachable ones are real caller mistakes:
 * 23514 from `annual_report_profiles_parent_consistency` (e.g. setting
 * `parent_group_size` on a row already stored with `is_parent_company = false`,
 * since the upsert only writes the columns present in the payload) and 42501
 * when RLS refuses the write. With the code intact those become 400/403 with a
 * Swedish message. SQLSTATEs that are genuine infrastructure trouble are not in
 * `postgresCodeToStructured()` and still fall through to 500.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  emptyAnnualReportProfile,
  type AnnualReportProfile,
} from './compliance-types'

const PROFILE_COLUMNS =
  'id, company_id, fiscal_period_id, is_public_limited_company, is_in_liquidation, securities_traded_on_regulated_market, is_parent_company, parent_group_size, prepares_consolidated_accounts, has_foreign_branch, has_crypto_assets, has_share_based_payments, has_convertible_debt, building_revenue_share_pct, has_material_deferred_tax, reporting_currency, auditor_report_required, auditor_report_included, dividend_prudence_confirmed, narrative_confirmed_at, k2_assessment_confirmed_at, signer_roster_confirmed_at, updated_at'

export type AnnualReportProfileUpdate = Partial<
  Omit<AnnualReportProfile, 'id' | 'company_id' | 'fiscal_period_id' | 'updated_at'>
>

export async function getAnnualReportProfile(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<AnnualReportProfile> {
  const { data, error } = await supabase
    .from('annual_report_profiles')
    .select(PROFILE_COLUMNS)
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw error
  return data
    ? (data as AnnualReportProfile)
    : emptyAnnualReportProfile(companyId, fiscalPeriodId)
}

export async function upsertAnnualReportProfile(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  input: AnnualReportProfileUpdate,
): Promise<AnnualReportProfile> {
  const payload: Record<string, unknown> = {
    company_id: companyId,
    fiscal_period_id: fiscalPeriodId,
    user_id: userId,
    ...input,
  }
  if (input.is_parent_company === false) {
    payload.parent_group_size = null
    payload.prepares_consolidated_accounts = null
  }
  const { data, error } = await supabase
    .from('annual_report_profiles')
    .upsert(payload, { onConflict: 'company_id,fiscal_period_id' })
    .select(PROFILE_COLUMNS)
    .single()
  if (error) throw error
  // `.single()` always reports a missing row as an error, so this is a
  // belt-and-braces guard rather than a reachable branch: keep it a plain
  // Error (no SQLSTATE to preserve) so it maps to 500.
  if (!data) throw new Error('Failed to save annual report profile: no row returned')
  return data as AnnualReportProfile
}
