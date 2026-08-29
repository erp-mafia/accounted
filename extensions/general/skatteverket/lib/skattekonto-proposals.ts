import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { findMatchSuggestionsBulk } from './skattekonto-match'

const log = createLogger('skattekonto-proposals')

export interface RefreshProposalsResult {
  considered: number
  proposed: number
  cleared: number
  unchanged: number
}

interface OpenRow {
  id: string
  transaktionsdatum: string
  transaktionstext: string | null
  belopp_skatteverket: number | string
  journal_entry_id: string | null
  suggested_journal_entry_id: string | null
}

/**
 * Recompute the exact-twin proposals for every open SKV row of a company and
 * persist them on `skattekonto_transactions.suggested_journal_entry_id`.
 *
 * Runs after every sync (and can be called after a booking/link mutation).
 * A proposal is never a link: only a click, or an approved staged operation,
 * moves it into journal_entry_id. Rows that are linked or ignored never
 * carry a proposal; rows whose candidate stopped qualifying get it cleared.
 *
 * Best-effort: logs and returns zeros on failure, never throws, so a
 * proposal hiccup cannot fail the sync it rides on.
 */
export async function refreshSkattekontoProposals(
  supabase: SupabaseClient,
  companyId: string,
): Promise<RefreshProposalsResult> {
  const zero: RefreshProposalsResult = { considered: 0, proposed: 0, cleared: 0, unchanged: 0 }
  let rows: OpenRow[]
  try {
    rows = await fetchAllRows<OpenRow>(
      ({ from, to }) =>
        supabase
          .from('skattekonto_transactions')
          .select(
            'id, transaktionsdatum, transaktionstext, belopp_skatteverket, journal_entry_id, suggested_journal_entry_id',
          )
          .eq('company_id', companyId)
          .eq('status', 'booked')
          .eq('is_ignored', false)
          .is('journal_entry_id', null)
          .order('transaktionsdatum', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      { dedupeBy: (r) => r.id },
    )
  } catch (err) {
    log.warn('proposal refresh: row read failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return zero
  }
  if (rows.length === 0) return zero

  const suggestions = await findMatchSuggestionsBulk(
    supabase,
    companyId,
    rows.map((r) => ({
      id: r.id,
      transaktionsdatum: r.transaktionsdatum,
      transaktionstext: r.transaktionstext,
      belopp_skatteverket: Number(r.belopp_skatteverket),
      journal_entry_id: r.journal_entry_id,
    })),
  )

  const now = new Date().toISOString()
  let proposed = 0
  let cleared = 0
  let unchanged = 0

  for (const row of rows) {
    const next = suggestions.get(row.id)?.journal_entry_id ?? null
    if (next === row.suggested_journal_entry_id) {
      unchanged++
      continue
    }
    const { error } = await supabase
      .from('skattekonto_transactions')
      .update({ suggested_journal_entry_id: next, suggested_at: next ? now : null })
      .eq('company_id', companyId)
      .eq('id', row.id)
      // A link written between our read and this update wins: never stamp a
      // proposal onto a row that is no longer open.
      .is('journal_entry_id', null)
    if (error) {
      log.warn('proposal refresh: update failed', {
        companyId,
        rowId: row.id,
        error: error.message,
      })
      continue
    }
    if (next) proposed++
    else cleared++
  }

  return { considered: rows.length, proposed, cleared, unchanged }
}
