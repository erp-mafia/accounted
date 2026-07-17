/**
 * Draft-only date tools for the local workshop (ADR 013 Fas 3).
 * Never mutates posted entries — use storno/correct for those.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'

export type DraftDateUpdate = {
  entryId: string
  entryDate: string
}

export type DraftDateBatchResult = {
  updated: string[]
  skipped: { entryId: string; reason: string }[]
}

/**
 * Set entry_date on draft journal entries. Reassigns fiscal_period_id when needed.
 */
export async function batchUpdateDraftEntryDates(
  supabase: SupabaseClient,
  companyId: string,
  updates: DraftDateUpdate[],
): Promise<DraftDateBatchResult> {
  const updated: string[] = []
  const skipped: { entryId: string; reason: string }[] = []

  for (const u of updates) {
    const entryDate = u.entryDate.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
      skipped.push({ entryId: u.entryId, reason: 'Invalid date' })
      continue
    }

    const { data: row, error } = await supabase
      .from('journal_entries')
      .select('id, status, entry_date')
      .eq('id', u.entryId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) {
      skipped.push({ entryId: u.entryId, reason: error.message })
      continue
    }
    if (!row) {
      skipped.push({ entryId: u.entryId, reason: 'Not found' })
      continue
    }
    if (row.status !== 'draft') {
      skipped.push({
        entryId: u.entryId,
        reason: 'Posted entries are immutable — use storno/correct',
      })
      continue
    }

    const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
    if (!fiscalPeriodId) {
      skipped.push({ entryId: u.entryId, reason: `No open fiscal period for ${entryDate}` })
      continue
    }

    const { error: updErr } = await supabase
      .from('journal_entries')
      .update({
        entry_date: entryDate,
        fiscal_period_id: fiscalPeriodId,
      })
      .eq('id', u.entryId)
      .eq('company_id', companyId)
      .eq('status', 'draft')

    if (updErr) {
      skipped.push({ entryId: u.entryId, reason: updErr.message })
      continue
    }
    updated.push(u.entryId)
  }

  return { updated, skipped }
}

/**
 * Suggest VAT period label (YYYY-MM or YYYY-QN) from entry date.
 * Monthly default; quarterly when periodMonths === 3.
 */
export function suggestVatPeriod(
  entryDate: string,
  periodMonths: 1 | 3 = 1,
): string {
  const ymd = entryDate.slice(0, 10)
  const y = Number.parseInt(ymd.slice(0, 4), 10)
  const m = Number.parseInt(ymd.slice(5, 7), 10)
  if (periodMonths === 3) {
    const q = Math.ceil(m / 3)
    return `${y}-Q${q}`
  }
  return `${y}-${String(m).padStart(2, '0')}`
}

/**
 * Align draft entry_date to a document/invoice date string when present.
 */
export async function alignDraftDatesFromSourceDates(
  supabase: SupabaseClient,
  companyId: string,
  items: { entryId: string; sourceDate: string }[],
): Promise<DraftDateBatchResult> {
  return batchUpdateDraftEntryDates(
    supabase,
    companyId,
    items.map((i) => ({ entryId: i.entryId, entryDate: i.sourceDate })),
  )
}
