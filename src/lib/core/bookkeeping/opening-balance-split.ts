import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryLineInput } from '@/types'
import { roundOre, ORE_TOLERANCE } from '@/lib/money'
import {
  carriesObjectBalances,
  fetchAccumulatingDimensions,
  splitBalanceLines,
  type ObjectBalanceSplit,
} from '@/lib/bookkeeping/dimension-carry'
import { isValidRegistryCode } from '@/lib/import/sie-object-balances'

/**
 * Year-end IB split per project (issue #3313).
 *
 * A closed year's balance-sheet accounts become next year's IB. Before, one
 * line per account: every project tag on this year's 1470/1510 lines was
 * lost at the year boundary, and a project-filtered ledger opened at zero.
 * Now each account's IB is split into one line per object of an accumulating
 * dimension (registry `resets_annually = false`, projekt on every company
 * today) holding that object's closing balance, plus one untagged remainder.
 * The VAT accounts (26xx) stay one untagged line (carriesObjectBalances).
 * Per-account totals are exactly the trial-balance amounts the IB always
 * used, so the entry's balance, the continuity check and every reader that
 * ignores tags see no change.
 */

/**
 * The closed year's closing balance per (balance-sheet account, bag projected
 * onto the company's accumulating dimensions), from
 * compute_object_closing_balances: the same basis as the trial balance (the
 * year's IB entry, or the prior-history fallback after a continuation import,
 * plus the year's lines). Empty when no dimension accumulates. A caller that
 * already read the registry passes its accumulating dimensions; otherwise
 * they are read here.
 */
export async function fetchObjectClosingBalances(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  accumulatingDimensions?: ReadonlySet<string>
): Promise<Map<string, ObjectBalanceSplit[]>> {
  const out = new Map<string, ObjectBalanceSplit[]>()
  const accumulating = accumulatingDimensions ?? (await fetchAccumulatingDimensions(supabase, companyId))
  if (accumulating.size === 0) return out

  const { data, error } = await supabase.rpc('compute_object_closing_balances', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_dim_nos: [...accumulating].sort((a, b) => Number(a) - Number(b)),
  })
  if (error) throw new Error(`compute_object_closing_balances failed: ${error.message}`)

  for (const raw of (Array.isArray(data) ? data : []) as unknown[]) {
    const row = raw as { account_number?: unknown; dimensions?: unknown; net?: unknown }
    const account = typeof row.account_number === 'string' ? row.account_number : ''
    const dimensions = wellFormedBag(row.dimensions)
    const amount = roundOre(Number(row.net) || 0)
    if (!account || !dimensions || amount === 0) continue
    const parts = out.get(account) ?? []
    parts.push({ dimensions, amount })
    out.set(account, parts)
  }
  return out
}

/**
 * A projected bag the engine can post: string codes the registry could hold
 * (jel_dimensions_well_formed). The CHECK was added NOT VALID, so legacy
 * lines (self-hosted in particular) may carry anything; a malformed bag is
 * left out of the split and its amount stays in the untagged remainder,
 * rather than fail the IB post after the year was closed.
 */
function wellFormedBag(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return null
  for (const [dimNo, code] of entries) {
    if (!/^[1-9][0-9]*$/.test(dimNo) || typeof code !== 'string' || !isValidRegistryCode(code)) return null
  }
  return Object.fromEntries(entries) as Record<string, string>
}

/**
 * Next year's IB lines: per balance-sheet account, one line per object part
 * and the untagged remainder. An account's lines always net to what the
 * one-line-per-account IB booked (nothing below ORE_TOLERANCE, otherwise the
 * öre-rounded closing balance). An account whose total is zero still carries
 * its objects' lines when they are nonzero (e.g. two projects offsetting on
 * 1470), with a remainder that nets them back to zero.
 *
 * The VAT accounts (26xx) are never split (carriesObjectBalances): their
 * project parts are ignored, so the whole balance is one untagged line.
 */
export function buildOpeningBalanceLines(
  accounts: ReadonlyArray<{ account_number: string; account_name: string; net: number }>,
  objects: ReadonlyMap<string, readonly ObjectBalanceSplit[]>
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  const seen = new Set<string>()
  for (const account of accounts) {
    seen.add(account.account_number)
    const total = Math.abs(account.net) < ORE_TOLERANCE ? 0 : roundOre(account.net)
    const parts = carriesObjectBalances(account.account_number) ? objects.get(account.account_number) : undefined
    if (total === 0 && !parts?.length) continue
    lines.push(...splitBalanceLines(account.account_number, total, parts, `Ingående balans: ${account.account_name}`))
  }
  // Defensive: tagged history always shows up in the trial balance, but an
  // object balance on an account the rows lack still nets to zero here.
  for (const [accountNumber, parts] of objects) {
    if (seen.has(accountNumber) || !parts.length || !carriesObjectBalances(accountNumber)) continue
    lines.push(...splitBalanceLines(accountNumber, 0, parts, `Ingående balans: ${accountNumber}`))
  }
  return lines
}
