import type { SupabaseClient } from '@supabase/supabase-js'

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
}

export interface CorrectionChainInfo {
  /** Backward hops from the entry to the chain root (0 = not part of a chain). */
  depth: number
  /** Voucher ref of the chain root (e.g. "A113"), when it was reached. */
  rootVoucher: string | null
}

/**
 * Walk `correction_of_id`/`reverses_id` backwards from `entry` and return the
 * chain depth plus the root voucher ref. One query per hop, capped at
 * MAX_CHAIN_WALK; a broken link (parent not found) or a cycle ends the walk.
 * An entry with no links costs zero queries.
 */
export async function correctionChainDepth(
  supabase: SupabaseClient,
  companyId: string,
  entry: ChainEntryRow
): Promise<CorrectionChainInfo> {
  const visited = new Set<string>([entry.id])
  let depth = 0
  let root: ChainEntryRow = entry
  let parentId = entry.correction_of_id ?? entry.reverses_id ?? null

  while (parentId && depth < MAX_CHAIN_WALK) {
    if (visited.has(parentId)) break
    visited.add(parentId)

    const { data: parent, error } = await supabase
      .from('journal_entries')
      .select('id, correction_of_id, reverses_id, voucher_series, voucher_number')
      .eq('id', parentId)
      .eq('company_id', companyId)
      .single()

    if (error || !parent) break

    depth++
    root = parent as ChainEntryRow
    parentId = root.correction_of_id ?? root.reverses_id ?? null
  }

  // Only a node with no backward link is the genuine chain root. When the
  // walk stopped early (broken link, cycle, MAX_CHAIN_WALK), `root` is just
  // the last node reached: presenting its voucher as the root would mislead.
  const reachedRoot = (root.correction_of_id ?? root.reverses_id) == null
  const rootVoucher =
    depth > 0 && reachedRoot && root.voucher_series && root.voucher_number != null
      ? `${root.voucher_series}${root.voucher_number}`
      : null

  return { depth, rootVoucher }
}
