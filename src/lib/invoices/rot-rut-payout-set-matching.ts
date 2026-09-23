/**
 * ROT/RUT payout SET matching: one bank row from Skatteverket that settles
 * several open begäran at once.
 *
 * Skatteverket decides per begäran but pays out everything it decided that
 * day in ONE transfer, so the bank row often equals no single request and the
 * 1:1 matcher (rot-rut-payout-matching.ts) stays silent. The candidate here
 * is the exact covering set: 1..4 open begäran whose expected payouts
 * (decided_total ?? requested_total) sum to the row to the öre. The search is
 * the reconciliation module's findExactCoveringSet; this file only decides
 * what goes into the pool and what comes out.
 *
 * Same refusals as the 1:1 matcher: SEK income rows only, unmatchable
 * requests never take part, and an ambiguous answer (a second, different set
 * of the same size that also closes the row) yields no suggestion: the
 * amount alone cannot say which begäran Skatteverket paid, and guessing
 * would clear the wrong 1513 fordran. There is no fuzzy pass on purpose:
 * Skatteverket pays exactly the decided sums.
 *
 * No hint column for a set. The inbox page, the worklist and the ingest path
 * recompute it from the open pool (a handful of rows per company), the way
 * expense-payout suggestions already are; a persisted uuid[] would need every
 * clear path the single hint has and could still go stale (#1259).
 *
 * Pure and client-safe on purpose: the inbox page runs it in the browser.
 */

import { findExactCoveringSet } from '@/lib/reconciliation/covering-set'
import { roundOre } from '@/lib/money'
import {
  expectedRotRutPayoutAmount,
  isMatchableRotRutPayoutRequest,
  mentionsSkatteverket,
  type RotRutPayoutRequestCandidate,
} from './rot-rut-payout-matching'

/** Largest set considered. Skatteverket rarely bundles more decisions per transfer. */
const DEFAULT_MAX_SET_SIZE = 4

export interface RotRutPayoutSetMatch<
  T extends RotRutPayoutRequestCandidate = RotRutPayoutRequestCandidate,
> {
  /** The begäran the row settles, in the order they are booked (largest first). */
  requests: T[]
  /** Sum of the requests' expected payouts: equals the row amount to the öre. */
  total: number
  confidence: number
  matchMethod: 'amount_skatteverket' | 'amount' | 'amount_sum_skatteverket' | 'amount_sum'
}

export interface RotRutSetMatchableTransaction {
  amount: number
  currency?: string | null
  description?: string | null
  merchant_name?: string | null
}

export interface RotRutSetMatchOptions {
  /** Largest set considered. Default 4. */
  maxSize?: number
}

interface PoolEntry<T extends RotRutPayoutRequestCandidate> {
  id: string
  amount: number
  dateDistanceDays: number
  request: T
}

function toPool<T extends RotRutPayoutRequestCandidate>(requests: T[]): PoolEntry<T>[] {
  return requests
    .filter((request) => isMatchableRotRutPayoutRequest(request))
    .map((request) => ({
      id: request.id,
      amount: expectedRotRutPayoutAmount(request),
      // No payout-date signal on a begäran: equal-size sets rank by amount,
      // then id (findExactCoveringSet's own deterministic order).
      dateDistanceDays: 0,
      request,
    }))
}

function searchSet<T extends RotRutPayoutRequestCandidate>(
  target: number,
  pool: PoolEntry<T>[],
  maxSize: number,
): PoolEntry<T>[] | null {
  return findExactCoveringSet(target, pool, { maxSize, maxCandidates: pool.length })
}

/**
 * Find the open begäran (1..maxSize of them) whose expected payouts sum to
 * an income transaction, or null. Pure: the caller loads the open requests
 * once.
 */
export function findRotRutPayoutSetMatch<T extends RotRutPayoutRequestCandidate>(
  transaction: RotRutSetMatchableTransaction,
  openRequests: T[],
  options: RotRutSetMatchOptions = {},
): RotRutPayoutSetMatch<T> | null {
  if (openRequests.length === 0) return null
  // Skatteverket pays in kronor only. A NULL currency on a legacy bank row
  // means SEK (transactions.currency DEFAULT 'SEK').
  if ((transaction.currency || 'SEK').toUpperCase() !== 'SEK') return null
  if (!(transaction.amount > 0)) return null

  const maxSize = Math.max(1, options.maxSize ?? DEFAULT_MAX_SET_SIZE)
  const target = roundOre(transaction.amount)
  const pool = toPool(openRequests)
  if (pool.length === 0) return null

  const best = searchSet(target, pool, maxSize)
  if (!best) return null

  // Ambiguity: any OTHER set of the same size that also closes the row must
  // omit at least one member of `best`, so dropping each member in turn and
  // searching again finds it if it exists. Sizes below |best| cannot appear
  // (the search returns the smallest set first), so a hit is a genuine tie.
  for (const member of best) {
    const without = pool.filter((entry) => entry.id !== member.id)
    if (searchSet(target, without, best.length)) return null
  }

  const named = mentionsSkatteverket(transaction)
  const single = best.length === 1
  return {
    requests: best.map((entry) => entry.request),
    total: roundOre(best.reduce((sum, entry) => sum + entry.amount, 0)),
    // A sum over several begäran is a weaker signal than one exact amount:
    // one notch below the 1:1 ladder (0.95 / 0.85).
    confidence: single ? (named ? 0.95 : 0.85) : named ? 0.9 : 0.8,
    matchMethod: single
      ? named
        ? 'amount_skatteverket'
        : 'amount'
      : named
        ? 'amount_sum_skatteverket'
        : 'amount_sum',
  }
}

export interface RotRutSetMatchableRow extends RotRutSetMatchableTransaction {
  id: string
  is_business?: boolean | null
  journal_entry_id?: string | null
  /**
   * A persisted 1:1 hint (rot-rut-payout-matching.ts) wins for its row and
   * takes its begäran out of the pool, so a set never offers a request that
   * another row is already about to settle.
   */
  potential_rot_rut_payout_request_id?: string | null
}

/**
 * Pair unbooked SEK income rows with the set of open begäran they settle.
 * Rows are walked in the order given (callers pass newest first); every set
 * handed out drains the pool, mirroring the one-payout-per-begäran rule at
 * bank ingest. Rows that are booked, already reviewed (is_business set) or
 * carrying a persisted 1:1 hint are skipped: they have their own path.
 */
export function matchTransactionsToRotRutPayoutSets<T extends RotRutPayoutRequestCandidate>(
  transactions: RotRutSetMatchableRow[],
  openRequests: T[],
  options: RotRutSetMatchOptions = {},
): Map<string, RotRutPayoutSetMatch<T>> {
  const out = new Map<string, RotRutPayoutSetMatch<T>>()
  if (transactions.length === 0 || openRequests.length === 0) return out

  const claimed = new Set<string>()
  for (const tx of transactions) {
    if (tx.potential_rot_rut_payout_request_id) claimed.add(tx.potential_rot_rut_payout_request_id)
  }
  let pool = openRequests.filter((request) => !claimed.has(request.id))

  for (const tx of transactions) {
    if (pool.length === 0) break
    if (tx.journal_entry_id) continue
    if (tx.is_business !== null && tx.is_business !== undefined) continue
    if (tx.potential_rot_rut_payout_request_id) continue
    const match = findRotRutPayoutSetMatch(tx, pool, options)
    if (!match) continue
    out.set(tx.id, match)
    const taken = new Set(match.requests.map((request) => request.id))
    pool = pool.filter((request) => !taken.has(request.id))
  }
  return out
}
