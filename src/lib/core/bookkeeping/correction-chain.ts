import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'

/**
 * Correction-chain depth walker.
 *
 * A rättelse chain is linked in the DB: a correction carries
 * `correction_of_id` and a storno carries `reverses_id`, both pointing at the
 * entry they replace/cancel. Walking those links backwards from an entry
 * gives the number of correction generations between it and the chain root
 * (the original verifikat).
 *
 * Depth is derived from the links, never from description parsing:
 * "Rättelse: Rättelse:" matching breaks the moment a caller supplies a custom
 * verifikationstext (allowed since issue #1031).
 *
 * Used by the chain-depth guard (Christoffer case 2026-08-11: agents looped
 * corrections of corrections 10 deep, drowning the journal in noise vouchers).
 */

/**
 * Depth at which correctEntry/reverseEntry refuse without an explicit
 * override. Original → rättelse → rättelse-av-rättelse is a legitimate flow
 * (someone fixes the fix); a target already 3+ links deep is thrash in
 * practice.
 */
export const CORRECTION_CHAIN_GUARD_DEPTH = 3

/** Hard cap on backward hops so a pathological or cyclic chain cannot loop. */
export const MAX_CHAIN_WALK = 10

interface ChainEntryRow {
  id: string
  correction_of_id?: string | null
  reverses_id?: string | null
  voucher_series?: string | null
  voucher_number?: number | null
  source_type?: string | null
  source_id?: string | null
}

export interface CorrectionChainInfo {
  /** Backward hops from the entry to the chain root (0 = not part of a chain). */
  depth: number
  /** Voucher ref of the chain root (e.g. "A113"), when it was reached. */
  rootVoucher: string | null
}

/** The original a rättelse chain starts from, with the source columns it was booked with. */
export interface CorrectionChainRoot {
  id: string
  source_type: string | null
  source_id: string | null
}

/**
 * Walk `correction_of_id`/`reverses_id` backwards from `entry`. One query per
 * hop, capped at MAX_CHAIN_WALK; a broken link (parent not found) or a cycle
 * ends the walk. An entry with no links costs zero queries. `reachedRoot` is
 * true only when the last node has no backward link: when the walk stopped
 * early, `root` is just the last node reached. `withSource` adds the source
 * columns the root walk needs; both selects stay literal so the
 * no-phantom-columns guard can check them. `links` 'correction' follows
 * correction_of_id alone, so the walk ends at a storno instead of passing it.
 * `readError` is the failed read that ended the walk, other than a parent
 * not found.
 */
async function walkToChainRoot(
  supabase: SupabaseClient,
  companyId: string,
  entry: ChainEntryRow,
  withSource: boolean,
  links: 'both' | 'correction' = 'both',
): Promise<{ depth: number; root: ChainEntryRow; reachedRoot: boolean; readError?: { message: string; code?: string } }> {
  const backLink = (row: ChainEntryRow) =>
    links === 'correction' ? (row.correction_of_id ?? null) : (row.correction_of_id ?? row.reverses_id ?? null)
  const visited = new Set<string>([entry.id])
  let depth = 0
  let root: ChainEntryRow = entry
  let parentId = backLink(entry)
  let readError: { message: string; code?: string } | undefined

  while (parentId && depth < MAX_CHAIN_WALK) {
    if (visited.has(parentId)) break
    visited.add(parentId)

    const { data: parent, error } = withSource
      ? await supabase
          .from('journal_entries')
          .select('id, correction_of_id, reverses_id, voucher_series, voucher_number, source_type, source_id')
          .eq('id', parentId)
          .eq('company_id', companyId)
          .single()
      : await supabase
          .from('journal_entries')
          .select('id, correction_of_id, reverses_id, voucher_series, voucher_number')
          .eq('id', parentId)
          .eq('company_id', companyId)
          .single()

    if (error || !parent) {
      if (error && (error as { code?: string }).code !== 'PGRST116') readError = error
      break
    }

    depth++
    root = parent as unknown as ChainEntryRow
    parentId = backLink(root)
  }

  return { depth, root, reachedRoot: backLink(root) == null, ...(readError ? { readError } : {}) }
}

/**
 * Walk `correction_of_id`/`reverses_id` backwards from `entry` and return the
 * chain depth plus the root voucher ref (walkToChainRoot).
 */
export async function correctionChainDepth(
  supabase: SupabaseClient,
  companyId: string,
  entry: ChainEntryRow
): Promise<CorrectionChainInfo> {
  const { depth, root, reachedRoot } = await walkToChainRoot(supabase, companyId, entry, false)
  // Presenting a node short of the root as the root would mislead.
  const rootVoucher =
    depth > 0 && reachedRoot && root.voucher_series && root.voucher_number != null
      ? formatVoucher(root)
      : null

  return { depth, rootVoucher }
}

export type LiveEntry = { id: string } | { none: true } | { exhausted: true }

/**
 * Follow a verifikat forwards through storno corrections (correctEntry links
 * the replacement by correction_of_id) to the one that is posted now. `none`
 * when there is no single live one (stornoed without a replacement, never
 * posted, or missing); `exhausted` when the walk would take more hops than
 * `budget` has left (shared by every walk of one resolution).
 *
 * A register that stores a voucher id (a supplier payment row, an accrual
 * installment) keeps pointing at the original after a rättelse, while the
 * books carry the correction: a caller acting on the register's voucher acts
 * on this one.
 */
export async function liveEntryOf(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
  budget: { hops: number } = { hops: MAX_CHAIN_WALK + 1 },
): Promise<LiveEntry> {
  const seen = new Set<string>()
  let currentId = entryId
  for (let hop = 0; hop <= MAX_CHAIN_WALK; hop++) {
    if (seen.has(currentId)) return { none: true }
    seen.add(currentId)
    if (budget.hops <= 0) return { exhausted: true }
    budget.hops--

    const { data: entry, error } = await supabase
      .from('journal_entries')
      .select('id, status')
      .eq('company_id', companyId)
      .eq('id', currentId)
      .maybeSingle()
    if (error) throw dbError(error, 'correction chain: live voucher')
    const row = entry as { id: string; status: string } | null
    if (!row) return { none: true }
    if (row.status === 'posted') return { id: row.id }
    if (row.status !== 'reversed') return { none: true }

    const { data: corrections, error: correctionError } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .eq('correction_of_id', row.id)
      .in('status', ['posted', 'reversed'])
      .limit(2)
    if (correctionError) throw dbError(correctionError, 'correction chain: voucher correction')
    const next = (corrections ?? []) as Array<{ id: string }>
    if (next.length !== 1) return { none: true }
    currentId = next[0].id
  }
  return { none: true }
}

/**
 * The original a storno or correction descends from, with its own source
 * columns: a storno is booked as source_type 'storno' and a correction as
 * 'correction', so what the chain books (an invoice, a periodisering) is read
 * off its root. An entry outside any chain is its own root. Null when the
 * walk stopped before the root (broken link, cycle, MAX_CHAIN_WALK).
 */
export async function correctionChainRoot(
  supabase: SupabaseClient,
  companyId: string,
  entry: ChainEntryRow,
): Promise<CorrectionChainRoot | null> {
  const { root, reachedRoot } = await walkToChainRoot(supabase, companyId, entry, true)
  if (!reachedRoot) return null
  return { id: root.id, source_type: root.source_type ?? null, source_id: root.source_id ?? null }
}

/**
 * The verifikat a correction corrects: followed back over correction_of_id
 * alone, through corrections of corrections, to the first one that corrects
 * nothing, with the source columns it was booked with (a correction itself
 * is booked as 'correction' with no source_id). Unlike correctionChainRoot it
 * does not continue over a storno's reverses_id: a correction of a storno
 * corrects that storno. An entry that corrects nothing is its own root. Null
 * when the walk stopped before the root (parent not found, cycle,
 * MAX_CHAIN_WALK); throws when a read fails.
 */
export async function correctedOriginalOf(
  supabase: SupabaseClient,
  companyId: string,
  entry: ChainEntryRow,
): Promise<CorrectionChainRoot | null> {
  const { root, reachedRoot, readError } = await walkToChainRoot(supabase, companyId, entry, true, 'correction')
  if (readError) throw dbError(readError, 'correction chain: corrected original')
  if (!reachedRoot) return null
  return { id: root.id, source_type: root.source_type ?? null, source_id: root.source_id ?? null }
}
