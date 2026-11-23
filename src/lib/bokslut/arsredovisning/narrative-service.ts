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
import type { NoteOverrides } from './note-overrides'
import type { DisclosureAnswers } from './disclosures/types'
import type { EquityMovementKind } from './equity-kinds'
import { normalizeFixedAssetNoteRows, type FixedAssetNoteRows } from './k2-fixed-asset-note'
import { isMissingColumnError } from '@/lib/pending-operations/agent-reason'

/** The user's classification of equity verifikat, by journal entry id. */
export type EquityMovementOverridesRow = Record<string, EquityMovementKind>

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
  /** ÅRL 6 kap. 3 § (ekonomisk förening): väsentliga förändringar i
   *  medlemsantalet, free text. Required before the document is fileable. */
  member_count_change: string | null
  /** ÅRL 6 kap. 3 § p. 2: insatser to be repaid next fiscal year (EFL 10
   *  kap. 11 and 16 §§). Null renders "inga". */
  insatser_repayable_next_year: number | null
  /** ÅRL 6 kap. 3 § p. 3: the distribution right förlagsinsatser carry. */
  forlagsinsatser_dividend_right: string | null
  /** ÅRL 6 kap. 3 § p. 4: förlagsinsatser given notice, redeemable within
   *  the next two fiscal years (EFL 11 kap. 7 §). Null renders "inga". */
  forlagsinsatser_redeemable_two_years: number | null
  long_term_debt_over_five_years_confirmed: boolean
  securities_pledged_confirmed: boolean
  contingent_liabilities_confirmed: boolean
  parent_company_confirmed: boolean
  agm_disposition_outcome: 'proposal_approved' | 'alternative_decision' | null
  agm_disposition_decision: string | null
  /** K3 note texts the user replaced, keyed by EditableNoteKey. A missing
   *  key means the generated text (note-overrides.ts). */
  note_overrides: NoteOverrides
  /** K3: leave the kassaflödesanalys out. Honoured only when the company
   *  is not a större företag (cash-flow-omission.ts). */
  omit_kassaflodesanalys: boolean
  /** The user confirmed the company is not a större företag under ÅRL
   *  1 kap. 3 §, needed when the product cannot determine the size. */
  kassaflodesanalys_omission_confirmed: boolean
  /** K3 disclosure matrix answers per requirement id (disclosures/). */
  disclosure_answers: DisclosureAnswers
  /** Equity verifikat the ledger cannot classify, classified by the user. */
  equity_movement_overrides: EquityMovementOverridesRow
  /** Print the equity specification as a statement of its own (K3 3.10). */
  equity_statement_separate: boolean
  /** K2: the rows of the anläggningstillgångar note that neither the
   *  register nor the ledger can tell apart (omräkningsdifferenser, where a
   *  nedskrivning outside the register came from or went), per balance sheet
   *  post (k2-fixed-asset-note.ts). */
  fixed_asset_note_rows: FixedAssetNoteRows
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
  /** ÅRL 6 kap. 3 § (ekonomisk förening): väsentliga förändringar i
   *  medlemsantalet, free text. Required before the document is fileable. */
  member_count_change: string | null
  /** ÅRL 6 kap. 3 § p. 2: insatser to be repaid next fiscal year (EFL 10
   *  kap. 11 and 16 §§). Null renders "inga". */
  insatser_repayable_next_year: number | null
  /** ÅRL 6 kap. 3 § p. 3: the distribution right förlagsinsatser carry. */
  forlagsinsatser_dividend_right: string | null
  /** ÅRL 6 kap. 3 § p. 4: förlagsinsatser given notice, redeemable within
   *  the next two fiscal years (EFL 11 kap. 7 §). Null renders "inga". */
  forlagsinsatser_redeemable_two_years: number | null
  long_term_debt_over_five_years_confirmed: boolean
  securities_pledged_confirmed: boolean
  contingent_liabilities_confirmed: boolean
  parent_company_confirmed: boolean
  agm_disposition_outcome: 'proposal_approved' | 'alternative_decision' | null
  agm_disposition_decision: string | null
  note_overrides: NoteOverrides
  omit_kassaflodesanalys: boolean
  kassaflodesanalys_omission_confirmed: boolean
  disclosure_answers: DisclosureAnswers
  equity_movement_overrides: EquityMovementOverridesRow
  equity_statement_separate: boolean
  /** Absent until the column's migration has run (NARRATIVE_API_COLUMNS). */
  fixed_asset_note_rows?: FixedAssetNoteRows
  updated_at: string
}

const TABLE = 'arsredovisning_narratives'

// Explicit projection: keeps user_id and other internal audit fields out
// of API responses. GDPR Art.25.2 / ISO A.8.3 data-minimization: callers
// only need the narrative content + last-updated timestamp.
const NARRATIVE_BASE_COLUMNS =
  'id, company_id, fiscal_period_id, description, important_events, resultatdisposition, proposed_dividend, agm_date, long_term_debt_over_five_years, securities_pledged, contingent_liabilities, parent_company_name, parent_company_org_number, parent_company_city, medelantal_anstallda_override, member_count_change, insatser_repayable_next_year, forlagsinsatser_dividend_right, forlagsinsatser_redeemable_two_years, long_term_debt_over_five_years_confirmed, securities_pledged_confirmed, contingent_liabilities_confirmed, parent_company_confirmed, agm_disposition_outcome, agm_disposition_decision, note_overrides, omit_kassaflodesanalys, kassaflodesanalys_omission_confirmed, disclosure_answers, equity_movement_overrides, equity_statement_separate, updated_at'

/**
 * fixed_asset_note_rows is the newest column. The code is live a few minutes
 * before the migration that adds it runs (it applies after the merge), so a
 * read or a save that fails on a missing column falls back to the columns
 * before it: the årsredovisning then has no stated rows, which is what an
 * unmigrated database holds.
 */
const NARRATIVE_API_COLUMNS = `${NARRATIVE_BASE_COLUMNS}, fixed_asset_note_rows`

async function withNewestColumn<T extends { error: { code?: string } | null }>(
  run: (columns: string) => PromiseLike<T>,
): Promise<T> {
  const first = await run(NARRATIVE_API_COLUMNS)
  return isMissingColumnError(first.error) ? run(NARRATIVE_BASE_COLUMNS) : first
}

/**
 * The stated rows of the K2 anläggningstillgångar note of every räkenskapsår
 * the company has a narrative for, by fiscal period. The note of a year reads
 * the years before it: an omräkningsdifferens an earlier year stated is still
 * in the post's opening balances (k2-fixed-asset-note.ts
 * carriedFromEarlierYears). Empty on a database without the column; another
 * read error throws, because a note built without the earlier years would
 * open with the wrong balance.
 */
export async function listFixedAssetNoteRows(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Map<string, FixedAssetNoteRows>> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('fiscal_period_id, fixed_asset_note_rows')
    .eq('company_id', companyId)
  if (isMissingColumnError(error)) return new Map()
  if (error) throw new Error(`Failed to load the stated rows of the anläggningstillgångar note: ${error.message}`)
  const rows = (data ?? []) as Array<{ fiscal_period_id: string; fixed_asset_note_rows: unknown }>
  return new Map(rows.map((row) => [row.fiscal_period_id, normalizeFixedAssetNoteRows(row.fixed_asset_note_rows)]))
}

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

/** What the årsstämma decided, as recorded on the narrative. */
export interface AgmDecision {
  agm_date: string | null
  agm_disposition_outcome: 'proposal_approved' | 'alternative_decision' | null
  agm_disposition_decision: string | null
}

/**
 * The AGM date and decision alone. A locked version froze the
 * fastställelseintyg as it stood at lock time, but the AGM is recorded after
 * the board has signed, so the filed intyg reads it from here. Null when no
 * narrative row exists; a read error throws, because filing without the AGM
 * the user did record would be wrong.
 */
export async function getAgmDecision(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<AgmDecision | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('agm_date, agm_disposition_outcome, agm_disposition_decision')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the AGM decision: ${error.message}`)
  return (data as AgmDecision | null) ?? null
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
  const { data, error } = await withNewestColumn((columns) =>
    supabase
      .from(TABLE)
      .select(columns)
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .maybeSingle(),
  )
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
  // A save that names fixed_asset_note_rows itself fails on an unmigrated
  // database and is not retried: the rows would be lost silently.
  const run = (columns: string) =>
    supabase
      .from(TABLE)
      .upsert(payload, { onConflict: 'company_id,fiscal_period_id' })
      .select(columns)
      .single()
  const { data, error } = 'fixed_asset_note_rows' in payload ? await run(NARRATIVE_API_COLUMNS) : await withNewestColumn(run)
  if (error) throw error
  // `.single()` always reports a missing row as an error, so this is a
  // belt-and-braces guard rather than a reachable branch: keep it a plain
  // Error (no SQLSTATE to preserve) so it maps to 500.
  if (!data) throw new Error('Failed to save narrative: no row returned')
  // The projection is a runtime string (the newest column may be missing),
  // so the client cannot type the row.
  return data as unknown as NarrativeRow
}
