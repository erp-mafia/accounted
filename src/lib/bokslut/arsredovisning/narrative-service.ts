/**
 * Persistence for the årsredovisning narrative overrides.
 *
 * Error contract: Supabase errors are rethrown untouched, exactly as
 * `lib/articles/validate-revenue-account.ts` does. Re-wrapping them in a plain
 * `new Error(...)` kept only `.message` and dropped `.code`, so `errorResponse()`
 * could no longer see the SQLSTATE and mapped every constraint failure on this
 * table to INTERNAL_ERROR / 500. The reachable one is a real caller mistake:
 * 23514 from `arsredovisning_narratives_agm_decision_consistency`, which the
 * route's Zod superRefine only catches when both fields arrive in the same
 * payload. A partial save (the upsert writes only the columns present in the
 * payload) can still leave the stored row with
 * `agm_disposition_outcome = 'alternative_decision'` and a blank decision, and
 * the DB is the last line of defence. With the code intact that becomes a 400
 * with a Swedish message; SQLSTATEs that are genuine infrastructure trouble are
 * not in `postgresCodeToStructured()` and still fall through to 500.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface NarrativeOverrides {
  description: string | null
  important_events: string | null
  resultatdisposition: string | null
  proposed_dividend: number | null
  /** ISO date of the AGM (årsstämma) where the årsredovisning was adopted.
   *  Populates the fastställelseintyg date blank: without it the PDF
   *  cannot be filed at Bolagsverket without manual pen-and-ink edit. */
  agm_date: string | null
  /** ÅRL 5:13 §: andel av långfristiga skulder som förfaller senare än
   *  fem år efter balansdagen. Null/0 → "Inga skulder förfaller efter mer
   *  än fem år." rendered in the note. */
  long_term_debt_over_five_years: number | null
  /** ÅRL 5:14 §: ställda säkerheter (panter, företagsinteckningar). Null
   *  → "Inga." */
  securities_pledged: string | null
  /** ÅRL 5:15 §: eventualförpliktelser (borgensåtaganden, garantier).
   *  Null → "Inga." */
  contingent_liabilities: string | null
  /** BFNAR 2016:10 kap. 19 / BFNAR 2012:1 kap. 8: moderföretagets namn.
   *  Note is emitted only when this is set; org_number and city are
   *  optional follow-up details. */
  parent_company_name: string | null
  parent_company_org_number: string | null
  parent_company_city: string | null
  /** ÅRL 5:20 §: manual medelantal anställda. Null → computed as an FTE
   *  average over the employees table. A whole number replaces the computed
   *  value in the note and the iXBRL fact for this period. */
  medelantal_anstallda_override: number | null
  long_term_debt_over_five_years_confirmed: boolean
  securities_pledged_confirmed: boolean
  contingent_liabilities_confirmed: boolean
  parent_company_confirmed: boolean
  agm_disposition_outcome: 'proposal_approved' | 'alternative_decision' | null
  agm_disposition_decision: string | null
}

/**
 * Shape returned from getNarrative / upsertNarrative. user_id and
 * created_at are deliberately excluded from the API projection (see
 * NARRATIVE_API_COLUMNS below).
 */
export interface NarrativeRow {
  id: string
  company_id: string
  fiscal_period_id: string
  description: string | null
  important_events: string | null
  resultatdisposition: string | null
  proposed_dividend: number | null
  agm_date: string | null
  long_term_debt_over_five_years: number | null
  securities_pledged: string | null
  contingent_liabilities: string | null
  parent_company_name: string | null
  parent_company_org_number: string | null
  parent_company_city: string | null
  medelantal_anstallda_override: number | null
  long_term_debt_over_five_years_confirmed: boolean
  securities_pledged_confirmed: boolean
  contingent_liabilities_confirmed: boolean
  parent_company_confirmed: boolean
  agm_disposition_outcome: 'proposal_approved' | 'alternative_decision' | null
  agm_disposition_decision: string | null
  updated_at: string
}

const TABLE = 'arsredovisning_narratives'

// Explicit projection: keeps user_id and other internal audit fields out
// of API responses. GDPR Art.25.2 / ISO A.8.3 data-minimization: callers
// only need the narrative content + last-updated timestamp.
const NARRATIVE_API_COLUMNS =
  'id, company_id, fiscal_period_id, description, important_events, resultatdisposition, proposed_dividend, agm_date, long_term_debt_over_five_years, securities_pledged, contingent_liabilities, parent_company_name, parent_company_org_number, parent_company_city, medelantal_anstallda_override, long_term_debt_over_five_years_confirmed, securities_pledged_confirmed, contingent_liabilities_confirmed, parent_company_confirmed, agm_disposition_outcome, agm_disposition_decision, updated_at'

/**
 * The medelantal anställda override alone, for a period other than the one
 * being built (the iXBRL note shows the jämförelseår in the same table, so
 * last year's manual figure must win there too). Null when no row or no
 * override; errors are swallowed because a missing jämförelsetal must never
 * block the current year's document.
 */
export async function getMedelantalOverride(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('medelantal_anstallda_override')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error || !data) return null
  const value = (data as { medelantal_anstallda_override: number | null })
    .medelantal_anstallda_override
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Load persisted narrative overrides for a fiscal period. Returns null when
 * the user hasn't customised anything yet: caller then falls back to the
 * auto-generated boilerplate in buildArsredovisningData.
 */
export async function getNarrative(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<NarrativeRow | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select(NARRATIVE_API_COLUMNS)
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw error
  return (data as NarrativeRow | null) ?? null
}

/**
 * Upsert narrative overrides for a fiscal period. Composite UNIQUE constraint
 * (company_id, fiscal_period_id) (see migration
 * 20260517160000_narrative_agm_date_and_composite_unique.sql) makes the
 * onConflict path resolve to an UPDATE within the same tenant, so repeated
 * saves cleanly replace prior content instead of stacking rows.
 */
export async function upsertNarrative(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  input: Partial<NarrativeOverrides>,
): Promise<NarrativeRow> {
  const payload: Record<string, unknown> = {
    user_id: userId,
    company_id: companyId,
    fiscal_period_id: fiscalPeriodId,
  }
  for (const [key, value] of Object.entries(input)) {
    payload[key] = value ?? null
  }
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'company_id,fiscal_period_id' })
    .select(NARRATIVE_API_COLUMNS)
    .single()
  if (error) throw error
  // `.single()` always reports a missing row as an error, so this is a
  // belt-and-braces guard rather than a reachable branch: keep it a plain
  // Error (no SQLSTATE to preserve) so it maps to 500.
  if (!data) throw new Error('Failed to save narrative: no row returned')
  return data as NarrativeRow
}
