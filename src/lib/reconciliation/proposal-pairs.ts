import { roundOre } from '@/lib/money'
import type { ReconciliationItem } from './schemas'

/** One skattekonto proposal as the bulk link sends it: the rows and the verifikat that holds them. */
export interface ProposalPairPreview {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  /** Every row of the pair: one, or the whole group a combined proposal names. */
  external_ids: string[]
  /** Sum of the rows, Skatteverket sign. */
  total: number
}

export interface ProposalPairsSummary {
  pairs: ProposalPairPreview[]
  row_count: number
  /** Sum of every row the pairs link, Skatteverket sign. */
  total: number
  entry_count: number
}

/**
 * The skattekonto proposals of a listing as the pairs one bulk link sends
 * (lib/reconciliation/actions.ts matchPairs): a combined proposal is ONE
 * pair of all its rows, a single proposal a pair of its row. Only what the
 * listing holds in full is counted, so the preview never shows a sum the
 * link would not make: a group whose rows are not all listed (a listing cut
 * at its cap) is left out.
 */
export function proposalPairsOf(items: ReconciliationItem[]): ProposalPairsSummary {
  const byId = new Map(items.map((i) => [i.item_id, i]))
  const seen = new Set<string>()
  const pairs: ProposalPairPreview[] = []
  for (const item of items) {
    const p = item.proposal
    if (item.bucket !== 'proposed' || item.item_type !== 'skattekonto_transaction' || !p) continue
    // A set of several verifikat (#2293) is the bank's shape, never the skattekonto's.
    if (p.vouchers && p.vouchers.length > 1) continue
    const ids = p.external_ids ?? [item.item_id]
    const key = `${p.journal_entry_id}|${[...ids].sort().join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    const rows = ids.map((id) => byId.get(id))
    if (rows.some((r) => !r)) continue
    pairs.push({
      journal_entry_id: p.journal_entry_id,
      voucher_series: p.voucher_series,
      voucher_number: p.voucher_number,
      entry_date: p.entry_date,
      description: p.description,
      external_ids: ids,
      total: rows.reduce((sum, r) => roundOre(sum + (r?.amount ?? 0)), 0),
    })
  }
  return {
    pairs,
    row_count: pairs.reduce((n, p) => n + p.external_ids.length, 0),
    total: pairs.reduce((sum, p) => roundOre(sum + p.total), 0),
    entry_count: new Set(pairs.map((p) => p.journal_entry_id)).size,
  }
}
