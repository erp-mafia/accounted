/**
 * Exact subset sum over a short candidate list: which posted bank legs, taken
 * together, add up to one bank row to the öre.
 *
 * Why this exists: a bank feed can deliver several affärshändelser as ONE row
 * (a Bankgirot daily aggregate, a lump payout), and each of them may already
 * be booked on its own (an invoice marked paid by hand, a salary voucher per
 * employee). The 1:1 duplicate check then sees no voucher of the row's amount
 * and stays silent, while the row is fully explained by two or three vouchers
 * that carry no bank link. The exact sum is a deterministic signal that needs
 * no counterparty text, which is what bank rows like "BGGIRERING 03447786"
 * never carry.
 *
 * Pure and client-safe on purpose: the same search can rank a suggestion in
 * the reconciliation view or guard a booking route without dragging server
 * dependencies into a component.
 *
 * Search order is smallest set first (one voucher beats two), and within one
 * size the set closest in date to the bank row. The candidate list is capped
 * before the search so a busy account cannot make the combinatorics
 * unbounded: with 40 candidates and sets of at most 4 the worst case is under
 * a hundred thousand partial sums, which is well below a millisecond of work.
 */

export interface CoveringCandidate {
  id: string
  /** Positive amount in the unit the target is stated in (SEK for bank legs). */
  amount: number
  /** |candidate date - bank row date| in whole days. Ranks equal-size sets. */
  dateDistanceDays: number
}

export interface CoveringSetOptions {
  /** Largest set considered. Default 4. */
  maxSize?: number
  /** Candidates kept (closest in date first) before the search. Default 40. */
  maxCandidates?: number
}

const DEFAULT_MAX_SIZE = 4
const DEFAULT_MAX_CANDIDATES = 40

function toOre(amount: number): number {
  return Math.round(amount * 100)
}

/**
 * Returns the best set of candidates whose amounts sum exactly to `target`
 * (to the öre), or null when no set of at most `maxSize` candidates does.
 * Candidates with a non-positive amount never take part; the target must be
 * positive (callers pass the absolute value of the bank row).
 */
export function findExactCoveringSet<T extends CoveringCandidate>(
  target: number,
  candidates: T[],
  options: CoveringSetOptions = {},
): T[] | null {
  const maxSize = Math.max(1, options.maxSize ?? DEFAULT_MAX_SIZE)
  const maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES)
  const targetOre = toOre(target)
  if (targetOre <= 0) return null

  const pool = candidates
    .map((c) => ({ candidate: c, ore: toOre(c.amount) }))
    .filter((c) => c.ore > 0 && c.ore <= targetOre)
    .sort((a, b) => {
      if (a.candidate.dateDistanceDays !== b.candidate.dateDistanceDays) {
        return a.candidate.dateDistanceDays - b.candidate.dateDistanceDays
      }
      if (a.ore !== b.ore) return b.ore - a.ore
      return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0
    })
    .slice(0, maxCandidates)

  for (let size = 1; size <= Math.min(maxSize, pool.length); size++) {
    let best: { indices: number[]; distance: number } | null = null
    const chosen: number[] = []

    const walk = (start: number, remaining: number, distance: number) => {
      if (chosen.length === size) {
        if (remaining === 0 && (best === null || distance < best.distance)) {
          best = { indices: [...chosen], distance }
        }
        return
      }
      const slotsLeft = size - chosen.length
      for (let i = start; i <= pool.length - slotsLeft; i++) {
        const entry = pool[i]
        if (entry.ore > remaining) continue
        // Nothing smaller than what is left can complete the set once the
        // last slot is being filled: skip instead of descending.
        if (slotsLeft === 1 && entry.ore !== remaining) continue
        chosen.push(i)
        walk(i + 1, remaining - entry.ore, distance + entry.candidate.dateDistanceDays)
        chosen.pop()
      }
    }

    walk(0, targetOre, 0)
    if (best !== null) {
      const found = best as { indices: number[]; distance: number }
      return found.indices.map((i) => pool[i].candidate)
    }
  }

  return null
}
