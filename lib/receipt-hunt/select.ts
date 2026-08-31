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
import {
  calculateMerchantSimilarity,
  normalizeForMatch,
} from '@/lib/documents/core-receipt-matcher'

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
 * Above this the arithmetic decides alone.
 *
 * An exact amount from a merchant the matcher recognises needs no second
 * opinion, and paying for one on every pair would be latency and cost for a
 * verdict nobody doubts.
 */
export const CERTAIN_CONFIDENCE = 0.8

/**
 * Below this nothing is worth a second opinion either: the signals disagree,
 * and asking a model to rescue a pair the evidence does not support is how
 * plausible-sounding wrong answers get made.
 */
export const UNCERTAIN_FLOOR = 0.6

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
  /** The receipt's total in kronor, resolved from a rate before scoring. */
  sek_total?: number | null
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
  /** The total in kronor, when a rate was resolved: both sides then compare. */
  sek_total?: number | null
  /** Settled by a second opinion rather than by the formula alone. */
  wasAdjudicated?: boolean
  /**
   * Where the document came from, carried through from the inbox item so the
   * proposal can say "found in your mailbox" rather than implying a human
   * uploaded it.
   */
  mailProvenance: {
    mailbox?: string
    subject?: string
    from?: string
  } | null
}

export interface SuppressionSets {
  /**
   * Transactions that already have an open or settled proposal. One live
   * question per purchase: a second one is noise even when it names a
   * different receipt.
   */
  claimedTransactionIds: ReadonlySet<string>
  /**
   * Receipts already offered to some purchase and not yet rejected. One
   * underlag belongs to one verifikat, and a proposal is a claim on it until a
   * human says otherwise.
   */
  claimedDocumentIds: ReadonlySet<string>
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
  /**
   * Lowest confidence worth returning. The caller lowers it to collect the
   * band it intends to adjudicate; every other guard still applies.
   */
  minConfidence: number = HUNT_MIN_CONFIDENCE,
): HuntProposal[] {
  if (pool.length === 0) return []

  const byLargestAmount = [...transactions].sort(
    (a, b) => Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0),
  )

  const poolById = new Map(pool.map((item) => [item.id, item]))

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
        // Never propose on the prominent-amounts fallback (non-invoice
        // documents: bankintyg, avtal). The hunt's thresholds were calibrated
        // for invoice-style totals; a fallback pair can reach 0.85 on date +
        // printed-figure alone, which clears CERTAIN_CONFIDENCE and skips
        // adjudication, and its preview would show document_amount null. The
        // hunt also scans outflows only, so an inflow-labeled figure
        // ("Insatt belopp") is guaranteed to pair with the wrong row. Those
        // documents stay reachable through the picker and agent candidates.
        candidate.amountSource !== 'prominent' &&
        !spentDocumentIds.has(candidate.document_id) &&
        !suppression.claimedDocumentIds.has(candidate.document_id) &&
        !suppression.rejectedPairs.has(pairKey(tx.id, candidate.document_id)),
    )
    if (scored.length === 0) continue

    const [winner, runnerUp] = scored
    if (winner.confidence < minConfidence) continue
    if (runnerUp && winner.confidence - runnerUp.confidence < AMBIGUITY_MARGIN) continue

    const documentId = winner.document_id as string
    spentDocumentIds.add(documentId)
    const context = poolById.get(winner.inbox_item_id)?.channel_context as
      | { channel?: string; mail_mailbox?: string; mail_subject?: string; mail_from?: string }
      | null
      | undefined
    proposals.push({
      mailProvenance:
        context?.channel === 'mail_hunt'
          ? {
              mailbox: context.mail_mailbox,
              subject: context.mail_subject,
              from: context.mail_from,
            }
          : null,
      transaction_id: tx.id,
      document_id: documentId,
      inbox_item_id: winner.inbox_item_id,
      confidence: winner.confidence,
      matchReasons: winner.matchReasons,
      merchant_name: winner.merchant_name,
      receipt_date: winner.receipt_date,
      total_amount: winner.total_amount,
      currency: winner.currency,
      sek_total: poolById.get(winner.inbox_item_id)?.sek_total ?? null,
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

/** Vendor names this alike are treated as the same merchant. */
export const FETCH_VENDOR_SIMILARITY = 0.6

/** How far a receipt's own date may sit from the charge and still be plausible. */
export const FETCH_DATE_WINDOW_DAYS = 10

/** Amounts within this fraction of each other are the same amount. */
const AMOUNT_TOLERANCE = 0.01

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000
}

/**
 * Is this mailbox document worth downloading?
 *
 * The gate before spending a fetch, a megabyte of storage and a page of the
 * granskningskö on a document. It is deliberately not the match: a mail body
 * states the total only about a quarter of the time, and the real amount comes
 * out of the PDF afterwards, at which point the ordinary matcher decides.
 *
 * Ordered by how much each signal is worth. An amount that agrees is close to
 * proof on its own, which is why it does not also need the vendor or the date.
 * A vendor that agrees is suggestive rather than conclusive, so it is asked to
 * bring a plausible date along. Everything else waits.
 */
export function worthFetching(
  doc: {
    vendor: string | null
    date: string | null
    amount: number | null
    currency: string | null
  },
  transactions: readonly HuntTransaction[],
  /**
   * The purchases whose own search turned this mail up.
   *
   * Already evidence, and evidence of a kind the document itself cannot carry:
   * the query was this purchase's amount or its merchant tokens, so a hit means
   * one of those appeared in the mail or inside its attachment. It rescues the
   * case where the two names genuinely differ, which is common and not an
   * error: the bank writes "Kontorsplatser j BG" and the landlord's invoice
   * says "Stockholm Innovation & Growth AB".
   */
  retrievedFor: readonly HuntTransaction[] = [],
): boolean {
  for (const tx of transactions) {
    if (tx.amount == null) continue
    const charged = Math.abs(tx.amount)

    // Same currency only. A EUR receipt against a SEK charge is not a
    // disagreement about the number, it is a different number: converting one
    // to the other is a guess and this code does not guess.
    if (
      doc.amount != null &&
      (doc.currency ?? 'SEK') === (tx.currency ?? 'SEK') &&
      Math.abs(doc.amount - charged) <= charged * AMOUNT_TOLERANCE
    ) {
      return true
    }

    if (!doc.vendor) continue
    const similarity = calculateMerchantSimilarity(
      doc.vendor,
      tx.merchant_name || tx.description || '',
    )
    if (similarity < FETCH_VENDOR_SIMILARITY) continue

    // No date on the receipt is missing evidence, not contrary evidence: the
    // vendor agreeing is enough to look inside the file.
    if (!doc.date || !tx.date) return true
    if (daysBetween(doc.date, tx.date) <= FETCH_DATE_WINDOW_DAYS) return true
  }

  for (const tx of retrievedFor) {
    if (!doc.date || !tx.date) continue
    if (daysBetween(doc.date, tx.date) <= FETCH_DATE_WINDOW_DAYS) return true
  }
  return false
}

/**
 * What identifies one purchase's paperwork, for deciding whether to fetch it.
 *
 * A mail carries the invoice and the receipt for the same purchase under
 * different names, and the same receipt reaches a second mailbox on another
 * message, so neither the filename nor the message id identifies anything.
 * The vendor, the total and the date do.
 *
 * The date is what keeps a subscription working. Anthropic bills the same
 * amount every month, and without a date every month after the first would be
 * treated as a duplicate of it and suppressed forever: a worse failure than
 * the duplicates this key exists to prevent, because it is permanent and
 * silent. Two documents for one purchase share a date; June and July do not.
 *
 * Without a vendor there is nothing to anchor an amount to, so those fall back
 * to the message and the file. The filename alone is not enough: half the
 * world's billing systems attach "invoice.pdf".
 */
export function receiptIdentity(doc: {
  vendor: string | null
  amount: number | null
  currency: string | null
  date?: string | null
  attachmentName?: string | null
  messageId?: string | null
}): string {
  const vendor = normalizeForMatch(doc.vendor ?? '').trim()
  if (vendor && doc.amount != null) {
    // Öre, not floating point: 0.1 + 0.2 must not read as a different total.
    const amount = Math.round(doc.amount * 100) / 100
    return `v1::${vendor}::${amount}::${(doc.currency ?? 'SEK').toLowerCase()}::${doc.date ?? ''}`
  }
  return `v1::file::${(doc.messageId ?? '').toLowerCase()}::${(doc.attachmentName ?? '').toLowerCase()}`
}
