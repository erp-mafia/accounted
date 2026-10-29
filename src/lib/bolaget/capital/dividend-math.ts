/**
 * A dividend split over the holders of the aktiebok on the decisive day.
 *
 * Two ways to state a dividend, as a stämma does (ABL 18:3 asks for the
 * amount per share):
 *   - per share: each holder gets amount_per_share x their shares, rounded
 *     to the öre; the dividend's total is the sum of those amounts, so the
 *     verifikat and the payouts agree to the öre.
 *   - a total: the total is split in proportion to the shares, in whole öre,
 *     by the largest remainder method. Every holder first gets the öre their
 *     exact share rounds down to; the öre left over (fewer than the number
 *     of holders) go one each to the holders with the largest fractions,
 *     ties to the larger holding and then by party id, so the split always
 *     sums to the total and the same register always splits the same way.
 *
 * Only the classes the dividend covers count (all when none are named). A
 * holder without shares in them gets nothing; a holder whose part rounds to
 * 0 öre is left out (a distribution row is always a positive amount).
 */
import { roundOre, sumOre } from '@/lib/money'

export interface DividendHolder {
  party_id: string
  by_class: ReadonlyArray<{ share_class_id: string; code: string; shares: number }>
}

export type DividendAmount = { kind: 'per_share'; amount_per_share: number } | { kind: 'total'; total: number }

export interface DistributionRow {
  party_id: string
  share_count: number
  amount: number
  by_class: Array<{ share_class_id: string; code: string; shares: number }>
}

export interface DividendSplit {
  total: number
  total_shares: number
  /** The amount per share as stated, or the total divided by the shares (for display only). */
  amount_per_share: number | null
  rows: DistributionRow[]
}

/** Whole öre of an amount already rounded to the öre (no float drift survives roundOre). */
function toOre(amount: number): bigint {
  return BigInt(Math.round(roundOre(amount) * 100))
}

function fromOre(ore: bigint): number {
  return roundOre(Number(ore) / 100)
}

export function splitDividend(
  holders: readonly DividendHolder[],
  amount: DividendAmount,
  shareClassIds: readonly string[] | null,
): DividendSplit {
  const covered = (classId: string) => !shareClassIds || shareClassIds.length === 0 || shareClassIds.includes(classId)
  const counted = holders
    .map((h) => {
      const byClass = h.by_class.filter((c) => covered(c.share_class_id) && c.shares > 0).map((c) => ({ ...c }))
      return { party_id: h.party_id, by_class: byClass, share_count: byClass.reduce((n, c) => n + c.shares, 0) }
    })
    .filter((h) => h.share_count > 0)
  const totalShares = counted.reduce((n, h) => n + h.share_count, 0)
  if (totalShares === 0) return { total: 0, total_shares: 0, amount_per_share: null, rows: [] }

  if (amount.kind === 'per_share') {
    const rows = counted
      .map((h) => ({ ...h, amount: roundOre(amount.amount_per_share * h.share_count) }))
      .filter((r) => r.amount > 0)
    return {
      total: sumOre(rows.map((r) => r.amount)),
      total_shares: totalShares,
      amount_per_share: amount.amount_per_share,
      rows: rows.map(({ party_id, share_count, amount: a, by_class }) => ({ party_id, share_count, amount: a, by_class })),
    }
  }

  const totalOre = toOre(amount.total)
  const sharesBig = BigInt(totalShares)
  const parts = counted.map((h) => {
    const exact = totalOre * BigInt(h.share_count)
    return { ...h, base: exact / sharesBig, fraction: exact % sharesBig }
  })
  let left = totalOre - parts.reduce((n, p) => n + p.base, BigInt(0))
  const order = [...parts].sort((a, b) =>
    a.fraction === b.fraction ? b.share_count - a.share_count || a.party_id.localeCompare(b.party_id) : a.fraction > b.fraction ? -1 : 1,
  )
  const extra = new Map<string, bigint>()
  for (const p of order) {
    if (left <= BigInt(0)) break
    extra.set(p.party_id, BigInt(1))
    left -= BigInt(1)
  }
  const rows = parts
    .map((p) => ({
      party_id: p.party_id,
      share_count: p.share_count,
      amount: fromOre(p.base + (extra.get(p.party_id) ?? BigInt(0))),
      by_class: p.by_class,
    }))
    .filter((r) => r.amount > 0)
  return {
    total: fromOre(totalOre),
    total_shares: totalShares,
    amount_per_share: null,
    rows,
  }
}
