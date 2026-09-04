/**
 * ROT/RUT payout matching: suggest the open begäran om utbetalning that an
 * income bank row from Skatteverket settles.
 *
 * Why the payout REQUEST and not the invoice: under fakturamodellen the
 * customer pays their share (settles the invoice, remaining_amount is stored
 * net of the deduction) and Skatteverket's share sits on BAS 1513 until the
 * agency pays out one lump sum per begäran, which may cover several invoices.
 * The invoice is therefore already `paid` when the SKV money lands and can
 * never be a match candidate; the request is the thing that still has an
 * outstanding balance.
 *
 * Confidence ladder (mirrors supplier-invoice-matching.ts):
 *   exact amount + Skatteverket named in description/merchant   -> 0.95
 *   exact amount only                                            -> 0.85
 * Two open requests with the same amount are ambiguous: no suggestion. There
 * is no fuzzy amount pass on purpose: Skatteverket pays exactly the decided
 * sum, so a near-miss is not this request.
 *
 * No server-only imports on purpose (only lib/money): client components
 * import the target-state helper too.
 */

import { roundOre } from '@/lib/money'

export const OPEN_ROT_RUT_PAYOUT_STATUSES = ['generated', 'submitted', 'partially_paid'] as const

/**
 * The columns the matcher and the match dialog need from
 * rot_rut_payout_requests. Numeric columns arrive as strings from PostgREST
 * (NUMERIC), so callers must coerce with Number() where they read them.
 */
export interface RotRutPayoutRequestCandidate {
  id: string
  name: string
  deduction_type: 'rot' | 'rut'
  status: string
  requested_total: number | string
  decided_total: number | string | null
  settlement_journal_entry_id: string | null
}

export interface RotRutPayoutMatch<T extends RotRutPayoutRequestCandidate = RotRutPayoutRequestCandidate> {
  request: T
  confidence: number
  matchMethod: 'amount_skatteverket' | 'amount'
}

export type RotRutPayoutMatchTargetState = 'matchable' | 'settled' | 'not_open'

const SKATTEVERKET_PATTERN = /skatteverket|\bskv\b/i

/** The amount Skatteverket is expected to pay: the beslut when recorded, else the request. */
export function expectedRotRutPayoutAmount(request: RotRutPayoutRequestCandidate): number {
  const raw = request.decided_total ?? request.requested_total
  return roundOre(Number(raw))
}

/**
 * Can this request still absorb a payout? Mirrors the settle route's guard:
 * no settlement voucher yet and not cancelled/rejected. `paid` counts as
 * settled even without a voucher id (a beslut import can flip status to paid
 * before the money is booked, but then the settle route is still the path and
 * the amount check below protects against a second payout).
 */
export function getRotRutPayoutMatchTargetState(
  request: RotRutPayoutRequestCandidate | null | undefined,
): RotRutPayoutMatchTargetState {
  if (!request) return 'not_open'
  if (request.settlement_journal_entry_id) return 'settled'
  if (request.status === 'paid') return 'settled'
  if (!(OPEN_ROT_RUT_PAYOUT_STATUSES as readonly string[]).includes(request.status)) return 'not_open'
  return 'matchable'
}

export function isMatchableRotRutPayoutRequest(
  request: RotRutPayoutRequestCandidate | null | undefined,
): boolean {
  return getRotRutPayoutMatchTargetState(request) === 'matchable'
}

interface MatchableTransaction {
  amount: number
  currency?: string | null
  description?: string | null
  merchant_name?: string | null
}

/**
 * Does the bank row name Skatteverket? Used both to boost confidence and, in
 * the dialog, to explain why the suggestion fired.
 */
export function mentionsSkatteverket(transaction: MatchableTransaction): boolean {
  return (
    SKATTEVERKET_PATTERN.test(transaction.description ?? '') ||
    SKATTEVERKET_PATTERN.test(transaction.merchant_name ?? '')
  )
}

/**
 * Find the open payout request an income transaction settles, or null.
 * Pure: the caller loads the open requests once per import batch.
 */
export function findRotRutPayoutMatch<T extends RotRutPayoutRequestCandidate>(
  transaction: MatchableTransaction,
  openRequests: T[],
): RotRutPayoutMatch<T> | null {
  if (openRequests.length === 0) return null
  // Skatteverket pays in kronor only. A NULL currency on a legacy bank row
  // means SEK (transactions.currency DEFAULT 'SEK').
  if ((transaction.currency || 'SEK').toUpperCase() !== 'SEK') return null
  if (!(transaction.amount > 0)) return null

  const txAmount = roundOre(transaction.amount)
  const hits = openRequests.filter(
    (request) =>
      isMatchableRotRutPayoutRequest(request) &&
      Math.abs(expectedRotRutPayoutAmount(request) - txAmount) < 0.005,
  )
  // Ambiguous: the amount alone cannot pick between two begäran. Never guess.
  if (hits.length !== 1) return null

  const named = mentionsSkatteverket(transaction)
  return {
    request: hits[0],
    confidence: named ? 0.95 : 0.85,
    matchMethod: named ? 'amount_skatteverket' : 'amount',
  }
}
