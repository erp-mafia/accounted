/**
 * Which receipt gets proposed for which unbooked card purchase.
 *
 * The hunt attaches an underlag to a transaction *before* it is booked, so the
 * gap never forms: `commitAttachDocumentToTransaction` sets
 * `invoice_inbox_items.matched_transaction_id`, and when the user later books
 * the transaction `categorize-core.ts` propagates that document onto the new
 * verifikat. Chasing already-posted verifikat is deliberately NOT this job:
 * that backlog is 96% imported history whose originals live in the previous
 * system, and it stays a pull (the `verifikat_missing_document` worklist).
 *
 * Everything here is pure so the ranking and every guard is unit-testable
 * without a database; the caller owns the reads and the staging write.
 */
import { scoreUnderlagCandidates, type CandidateTransaction } from '@/lib/agent-context/underlag-candidates'

/**
 * Confidence a candidate must reach to be proposed unattended.
 *
 * Above `CANDIDATE_MIN_CONFIDENCE` (0.6), which governs candidates an agent
 * reads and reasons about with a human in the loop. A proposal staged by the
 * nightly hunt is read as "these two belong together", so it trades recall for
 * precision: a wrong receipt on the wrong purchase is a mis-booking, and the
 * weaker pairs still reach the user through the manual picker.
 */
export const HUNT_MIN_CONFIDENCE = 0.7

/**
 * How far clear the winner must be before we propose it.
 *
 * Two receipts scoring the same against one purchase is a signal, not a tie to
 * break: a duplicate, a split payment, or a recurring charge whose sibling we
 * picked at random. Proposing either would be a coin flip presented as a
 * finding, so both are left to the picker.
 */
export const AMBIGUITY_MARGIN = 0.05

/**
 * Proposals per company per run.
 *
 * The queue is drained largest-amount-first over several nights instead of
 * arriving at once: prod holds companies with hundreds of receiptless
 * purchases, and a first run that staged all of them would bury the
 * granskningskö the feature is supposed to relieve.
 */
export const MAX_PROPOSALS_PER_RUN = 20

/** A transaction the hunt may propose an underlag for. */
export interface HuntTransaction extends CandidateTransaction {
  company_id: string
}

/** An unconsumed inbox item, already filtered to ones whose document is attachable. */
export interface HuntPoolItem {
  id: string
  document_id: string | null
  extracted_data: unknown
  channel_context: unknown
}

export interface HuntProposal {
  transaction_id: string
  document_id: string
  inbox_item_id: string
  confidence: number
  matchReasons: string[]
  /** Receipt-side facts, for the approval preview. */
  merchant_name: string | null
  receipt_date: string | null
  total_amount: number | null
  currency: string | null
}

export interface SuppressionSets {
  /**
   * Transactions that already have an open or settled proposal. One live
   * question per purchase: a second one is noise even when it names a
   * different receipt.
   */
  claimedTransactionIds: ReadonlySet<string>
  /**
   * Pairs a human already said no to, as `${transaction_id}:${document_id}`.
   * Scoped to the pair rather than the transaction so a rejection retires one
   * wrong guess without retiring the purchase.
   */
  rejectedPairs: ReadonlySet<string>
}

export function pairKey(transactionId: string, documentId: string): string {
  return `${transactionId}:${documentId}`
}

/**
 * Rank the pool against each transaction and return the proposals worth
 * staging, strongest purchases first.
 *
 * Ordering is by absolute amount, not by confidence: when the cap truncates the
 * run, the money that matters most for the books should be the part that gets
 * asked about tonight.
 */
export function selectProposals(
  transactions: readonly HuntTransaction[],
  pool: readonly HuntPoolItem[],
  suppression: SuppressionSets,
  limit: number = MAX_PROPOSALS_PER_RUN,
): HuntProposal[] {
  if (pool.length === 0) return []

  const byLargestAmount = [...transactions].sort(
    (a, b) => Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0),
  )

  const proposals: HuntProposal[] = []
  // One receipt can only settle one purchase, and the pool is scored per
  // transaction, so the same document can win twice in a single run. Whoever
  // is scored first (the larger amount) keeps it.
  const spentDocumentIds = new Set<string>()

  for (const tx of byLargestAmount) {
    if (proposals.length >= limit) break
    if (suppression.claimedTransactionIds.has(tx.id)) continue

    const scored = scoreUnderlagCandidates(tx, pool as never[]).filter(
      (candidate) =>
        candidate.document_id != null &&
        !spentDocumentIds.has(candidate.document_id) &&
        !suppression.rejectedPairs.has(pairKey(tx.id, candidate.document_id)),
    )
    if (scored.length === 0) continue

    const [winner, runnerUp] = scored
    if (winner.confidence < HUNT_MIN_CONFIDENCE) continue
    if (runnerUp && winner.confidence - runnerUp.confidence < AMBIGUITY_MARGIN) continue

    const documentId = winner.document_id as string
    spentDocumentIds.add(documentId)
    proposals.push({
      transaction_id: tx.id,
      document_id: documentId,
      inbox_item_id: winner.inbox_item_id,
      confidence: winner.confidence,
      matchReasons: winner.matchReasons,
      merchant_name: winner.merchant_name,
      receipt_date: winner.receipt_date,
      total_amount: winner.total_amount,
      currency: winner.currency,
    })
  }

  return proposals
}

/**
 * Payments that cannot have an emailed receipt, however hard we look.
 *
 * Salary, tax, employer contributions, VAT settlements, dividends, loan
 * amortisation and interest are all money moving on the strength of a
 * declaration or an agreement, not a purchase a merchant confirms by mail.
 *
 * Deliberately narrow. Supplier payments over bankgiro DO arrive with an
 * emailed invoice (a provkörning matched a Sting office invoice that way), and
 * an "Utlägg" reimbursement has a real receipt behind it, so neither the rail
 * nor the word "överföring" is grounds for skipping.
 *
 * Swedish bank statements truncate hard, which is why "skat" has to match as
 * well as "skatt": a real ledger row reads "Inbetalning skat BG 000005...".
 */
const NO_EMAIL_RECEIPT_EXISTS =
  /\bl[oö]n\b|\bl[oö]ner\b|\bskatt?\b|skatteverket|arbetsgivaravg|\bmoms\b|utdelning|amortering|\br[aä]nta\b|egen ins[aä]ttning/i

/**
 * Whether it is worth spending a mailbox search on this purchase.
 *
 * Only gates the mail leg: the Underlag pairing is scored on amount and
 * merchant and is already safe on these rows.
 */
export function canHaveEmailReceipt(description: string | null | undefined): boolean {
  if (!description) return true
  return !NO_EMAIL_RECEIPT_EXISTS.test(description)
}
