import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The company's räkenskapsår as one prompt line, so the assistant knows which
 * years exist and how to address them. Without it the model only ever saw
 * the report tools' "default: most recent" and read a multi-year ledger as a
 * single-year one (#2185): a question about 2023 had no period_id to pass
 * and no hint that one existed.
 *
 * Shared by the single-call assistant snapshot (lib/agent/ask/snapshot.ts)
 * and the streaming chat's identity block (lib/agent/chat/system-prompt.ts),
 * so both surfaces carry the same inventory from one query. Company-scoped
 * and best-effort: a failing query yields an empty list, never an error.
 */

export interface FiscalYearInventoryRow {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
}

/** Newest first. Enough for a decade of imports without bloating the prompt. */
export const FISCAL_YEAR_INVENTORY_CAP = 8

export async function loadFiscalYearInventory(
  supabase: SupabaseClient,
  companyId: string,
): Promise<FiscalYearInventoryRow[]> {
  try {
    const { data } = await supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed')
      .eq('company_id', companyId)
      .order('period_start', { ascending: false })
      .limit(FISCAL_YEAR_INVENTORY_CAP)
    return ((data ?? []) as FiscalYearInventoryRow[]).filter(
      (row) => typeof row?.id === 'string' && typeof row.period_start === 'string',
    )
  } catch {
    return []
  }
}

/**
 * "Räkenskapsår (senaste först): 2026-01-01..2026-12-31 period_id=<uuid>
 * (senaste); 2025-01-01..2025-12-31 period_id=<uuid> (avslutat)." Null when
 * the company has no periods, so the caller can drop the line.
 */
export function renderFiscalYearInventory(rows: FiscalYearInventoryRow[]): string | null {
  if (rows.length === 0) return null
  const items = rows.map((row, index) => {
    const marks: string[] = []
    if (index === 0) marks.push('senaste')
    if (row.is_closed) marks.push('avslutat')
    const suffix = marks.length > 0 ? ` (${marks.join(', ')})` : ''
    return `${row.period_start}..${row.period_end} period_id=${row.id}${suffix}`
  })
  return `Räkenskapsår (senaste först): ${items.join('; ')}.`
}

/**
 * The rule that goes with the inventory: how to ask a report tool about an
 * earlier year, and to say which year an answer covers.
 */
export const FISCAL_YEAR_RULE =
  'Frågor om ett tidigare räkenskapsår: skicka det årets period_id till rapportverktygen (resultatrapport, balansrapport, KPI, huvudbok, saldobalans); utan period_id läser de det senaste året. Säg alltid vilket räkenskapsår svaret gäller.'
