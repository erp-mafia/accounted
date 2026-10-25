import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fileOpeningBalanceByAccount, storedOpeningBalances } from '@/lib/import/sie-continuity'
import type { AccountMapping } from '@/lib/import/types'
import type { OpeningBalanceLine } from './execute-helpers'

/**
 * The ingående balanser a year's SIE file stated, for a year whose import
 * did not book them.
 *
 * A continuation import (the company already had activity before the year)
 * skips the file's #IB: the year's IB follows the prior year's lines
 * instead. The file's statement survives only in the import's sealed
 * manifest (effectiveOpeningBalances, the globally resolved IB set), in
 * source account numbers. When the prior year is later undone, that
 * statement is what the year's IB is booked from (crm#1099).
 */
export interface SIEFileOpeningBalance {
  importId: string
  filename: string
  lines: OpeningBalanceLine[]
  totalDebit: number
  totalCredit: number
}

interface ImportRow {
  id: string
  filename: string | null
  manifest: unknown
}

/**
 * Maps the stored balances through the import's own approved mappings, the
 * way buildSplitOpeningLines does: an account without a target is skipped,
 * several source accounts on one target are summed.
 */
export function toSIEFileOpeningBalance(row: ImportRow): SIEFileOpeningBalance | null {
  const manifest = (row.manifest ?? {}) as {
    effectiveOpeningBalances?: unknown
    input?: { mappings?: unknown }
  }
  const mappings = Array.isArray(manifest.input?.mappings) ? (manifest.input.mappings as AccountMapping[]) : []
  const byAccount = fileOpeningBalanceByAccount(storedOpeningBalances(manifest.effectiveOpeningBalances), mappings)

  const lines: OpeningBalanceLine[] = [...byAccount]
    .filter(([, amount]) => amount !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([account_number, amount]) => ({
      account_number,
      debit_amount: amount > 0 ? amount : 0,
      credit_amount: amount < 0 ? roundOre(-amount) : 0,
    }))
  if (lines.length === 0) return null

  return {
    importId: row.id,
    filename: row.filename ?? '',
    lines,
    totalDebit: roundOre(lines.reduce((sum, line) => sum + line.debit_amount, 0)),
    totalCredit: roundOre(lines.reduce((sum, line) => sum + line.credit_amount, 0)),
  }
}

/**
 * Whether the year just before `periodStart` holds live bokföring again: a
 * posted verifikat in it that is not a storno (an undone import leaves only
 * reversed originals and their stornos). The review that offers the file's
 * IB is raised when that year's import is undone, and a later import of the
 * same year leaves it open when this year has no IB verifikat. The year then
 * opens on the year before's utgående balanser again, as a continuation
 * import leaves it, so booking the file's #IB on top would open it on other
 * balances than the year before closed on (ÅRL 2 kap. kontinuitet; PH 193).
 */
export async function previousYearHasBookkeeping(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
): Promise<boolean> {
  const { data: previous, error: previousError } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lt('period_end', periodStart)
    .order('period_end', { ascending: false })
    .limit(1)
  if (previousError) throw previousError
  const previousId = (previous as { id: string }[] | null)?.[0]?.id
  if (!previousId) return false

  const { data, error } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', previousId)
    .eq('status', 'posted')
    .neq('source_type', 'storno')
    .limit(1)
  if (error) throw error
  return ((data as unknown[] | null) ?? []).length > 0
}

/** The latest completed import of the year, read for its stored IB. */
export async function readSIEFileOpeningBalance(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<SIEFileOpeningBalance | null> {
  const { data, error } = await supabase
    .from('sie_imports')
    .select('id, filename, manifest')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('job_kind', 'import')
    .eq('job_state', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  const row = (data as ImportRow[] | null)?.[0]
  return row ? toSIEFileOpeningBalance(row) : null
}
