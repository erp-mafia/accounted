import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * What the förening adds to its förenklat årsbokslut beyond the ledger, one
 * row per räkenskapsår (forenklat_arsbokslut_inputs, migration
 * 20261015180300): the eligibility confirmation with who and when, the
 * tilläggsupplysningar (BFNAR 2010:1 5.3) and the styrelseledamöter who sign.
 *
 * Supabase errors are rethrown untouched so errorResponse() keeps the
 * SQLSTATE (a CHECK violation becomes a 400, an RLS refusal a 403).
 */

export interface ForenklatArsbokslutSignatory {
  name: string
  /** Ordförande, kassör, ledamot: printed under the name; null prints none. */
  role: string | null
}

export interface ForenklatArsbokslutInputs {
  /** When a member confirmed the BFL 6 kap. 3 § conditions for the year; null until then. */
  eligibility_confirmed_at: string | null
  /** Tilläggsupplysningar, printed after the balansräkning. */
  notes: string | null
  signatories: ForenklatArsbokslutSignatory[]
  updated_at: string | null
}

export interface ForenklatArsbokslutInputsUpdate {
  /** true records the confirmation now in the caller's name (kept if already given); false withdraws it. */
  eligibility_confirmed?: boolean
  notes?: string | null
  /** A missing or blank role prints no role. */
  signatories?: Array<{ name: string; role?: string | null }>
}

export const EMPTY_FORENKLAT_ARSBOKSLUT_INPUTS: ForenklatArsbokslutInputs = {
  eligibility_confirmed_at: null,
  notes: null,
  signatories: [],
  updated_at: null,
}

function fromRow(row: Record<string, unknown> | null): ForenklatArsbokslutInputs {
  if (!row) return { ...EMPTY_FORENKLAT_ARSBOKSLUT_INPUTS }
  const signatories = Array.isArray(row.signatories) ? row.signatories : []
  return {
    eligibility_confirmed_at: typeof row.eligibility_confirmed_at === 'string' ? row.eligibility_confirmed_at : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    signatories: signatories.flatMap((s) => {
      const entry = s as { name?: unknown; role?: unknown }
      if (typeof entry?.name !== 'string' || entry.name.trim() === '') return []
      return [{ name: entry.name, role: typeof entry.role === 'string' && entry.role.trim() !== '' ? entry.role : null }]
    }),
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
  }
}

export async function getForenklatArsbokslutInputs(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<ForenklatArsbokslutInputs> {
  const { data, error } = await supabase
    .from('forenklat_arsbokslut_inputs')
    .select('eligibility_confirmed_at, notes, signatories, updated_at')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw error
  return fromRow(data as Record<string, unknown> | null)
}

/**
 * Save the year's row: the fields present in `update` are replaced, the others
 * keep their stored value. A confirmation already on record keeps its
 * original who and when; false withdraws it.
 */
export async function saveForenklatArsbokslutInputs(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  update: ForenklatArsbokslutInputsUpdate,
): Promise<ForenklatArsbokslutInputs> {
  const { data: stored, error: readError } = await supabase
    .from('forenklat_arsbokslut_inputs')
    .select('eligibility_confirmed_at, eligibility_confirmed_by, notes, signatories')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (readError) throw readError
  const current = stored as {
    eligibility_confirmed_at: string | null
    eligibility_confirmed_by: string | null
    notes: string | null
    signatories: unknown
  } | null

  const notes = update.notes === undefined ? (current?.notes ?? null) : update.notes?.trim() || null
  const signatories =
    update.signatories === undefined
      ? (current?.signatories ?? [])
      : update.signatories
          .map((s) => ({ name: s.name.trim(), role: s.role?.trim() ? s.role.trim() : null }))
          .filter((s) => s.name !== '')
  const wasConfirmed = Boolean(current?.eligibility_confirmed_at)
  const confirmed = update.eligibility_confirmed ?? wasConfirmed
  const confirmedAt = !confirmed
    ? null
    : wasConfirmed
      ? (current?.eligibility_confirmed_at ?? null)
      : new Date().toISOString()
  const confirmedBy = !confirmed ? null : wasConfirmed ? (current?.eligibility_confirmed_by ?? null) : userId

  const { data, error } = await supabase
    .from('forenklat_arsbokslut_inputs')
    .upsert(
      {
        company_id: companyId,
        fiscal_period_id: fiscalPeriodId,
        eligibility_confirmed_at: confirmedAt,
        eligibility_confirmed_by: confirmedBy,
        notes,
        signatories,
        updated_by: userId,
      },
      { onConflict: 'company_id,fiscal_period_id' },
    )
    .select('eligibility_confirmed_at, notes, signatories, updated_at')
    .single()
  if (error) throw error
  return fromRow(data as Record<string, unknown>)
}
