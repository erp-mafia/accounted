import type { SupabaseClient } from '@supabase/supabase-js'

export interface NarrativeOverrides {
  description: string | null
  important_events: string | null
  resultatdisposition: string | null
  /** ISO date of the AGM (årsstämma) where the årsredovisning was adopted.
   *  Populates the fastställelseintyg date blank — without it the PDF
   *  cannot be filed at Bolagsverket without manual pen-and-ink edit. */
  agm_date: string | null
  /** ÅRL 5:13 § — andel av långfristiga skulder som förfaller senare än
   *  fem år efter balansdagen. Null/0 → "Inga skulder förfaller efter mer
   *  än fem år." rendered in the note. */
  long_term_debt_over_five_years: number | null
  /** ÅRL 5:14 § — ställda säkerheter (panter, företagsinteckningar). Null
   *  → "Inga." */
  securities_pledged: string | null
  /** ÅRL 5:15 § — eventualförpliktelser (borgensåtaganden, garantier).
   *  Null → "Inga." */
  contingent_liabilities: string | null
  /** BFNAR 2016:10 kap. 19 / BFNAR 2012:1 kap. 8 — moderföretagets namn.
   *  Note is emitted only when this is set; org_number and city are
   *  optional follow-up details. */
  parent_company_name: string | null
  parent_company_org_number: string | null
  parent_company_city: string | null
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
  agm_date: string | null
  long_term_debt_over_five_years: number | null
  securities_pledged: string | null
  contingent_liabilities: string | null
  parent_company_name: string | null
  parent_company_org_number: string | null
  parent_company_city: string | null
  updated_at: string
}

const TABLE = 'arsredovisning_narratives'

// Explicit projection — keeps user_id and other internal audit fields out
// of API responses. GDPR Art.25.2 / ISO A.8.3 data-minimization: callers
// only need the narrative content + last-updated timestamp.
const NARRATIVE_API_COLUMNS =
  'id, company_id, fiscal_period_id, description, important_events, resultatdisposition, agm_date, long_term_debt_over_five_years, securities_pledged, contingent_liabilities, parent_company_name, parent_company_org_number, parent_company_city, updated_at'

/**
 * Load persisted narrative overrides for a fiscal period. Returns null when
 * the user hasn't customised anything yet — caller then falls back to the
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
  if (error) throw new Error(`Failed to load narrative: ${error.message}`)
  return (data as NarrativeRow | null) ?? null
}

/**
 * Upsert narrative overrides for a fiscal period. Composite UNIQUE constraint
 * (company_id, fiscal_period_id) — see migration
 * 20260517160000_narrative_agm_date_and_composite_unique.sql — makes the
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
  const payload = {
    user_id: userId,
    company_id: companyId,
    fiscal_period_id: fiscalPeriodId,
    description: input.description ?? null,
    important_events: input.important_events ?? null,
    resultatdisposition: input.resultatdisposition ?? null,
    agm_date: input.agm_date ?? null,
    long_term_debt_over_five_years: input.long_term_debt_over_five_years ?? null,
    securities_pledged: input.securities_pledged ?? null,
    contingent_liabilities: input.contingent_liabilities ?? null,
    parent_company_name: input.parent_company_name ?? null,
    parent_company_org_number: input.parent_company_org_number ?? null,
    parent_company_city: input.parent_company_city ?? null,
  }
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'company_id,fiscal_period_id' })
    .select(NARRATIVE_API_COLUMNS)
    .single()
  if (error || !data) {
    throw new Error(`Failed to save narrative: ${error?.message ?? 'unknown'}`)
  }
  return data as NarrativeRow
}
