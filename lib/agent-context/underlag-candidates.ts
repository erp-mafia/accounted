/**
 * Probable underlag for a bank transaction, among the inbox items nobody has
 * matched to anything yet.
 *
 * Why this is needed at all: every surface finds underlag through
 * invoice_inbox_items.matched_transaction_id, and WhatsApp intake never writes
 * it. process-inbound.ts calls uploadAndExtract with its matchedTransactionId
 * argument undefined, so upload-and-extract.ts inserts NULL, and it does not
 * set transactions.document_id either (that mirror is written by the manual
 * match route). Only TransactionMatchPicker fills either column. So a user who
 * photographs a receipt into WhatsApp, opens the app and clicks the bank
 * transaction has an underlag that no lookup can reach: the assistant reports
 * "UNDERLAG: saknas" about a receipt we are holding, and asks again for answers
 * they already gave in chat.
 *
 * Candidates are PROPOSALS, never links. Nothing here writes
 * matched_transaction_id; the caller surfaces the candidate and a human
 * confirms it, so the existing "a person links the underlag" step stays intact
 * rather than being quietly automated.
 *
 * Core lib: must not import from @/extensions. The scoring half is pure so the
 * ranking is unit-testable without a database.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CONVERTED_AMOUNT_TOLERANCE_PERCENT,
  DATE_TOLERANCE_DAYS,
  FALLBACK_CONFIDENCE_FACTOR,
  amountVarianceForMatch,
  bestProminentAmountVariance,
  calculateMatchConfidence,
  calculateMerchantSimilarity,
} from '@/lib/documents/core-receipt-matcher'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'
import type { InboxChannelContext, InvoiceExtractionResult } from '@/types'

/**
 * Confidence floor for surfacing an unmatched item as a probable underlag.
 * Deliberately above core-receipt-matcher's MIN_MATCH_CONFIDENCE (0.4): that
 * floor governs a picker where a human reads a ranked list and judges, whereas
 * a candidate named here is read by an agent that will reason from it. A wrong
 * receipt on the wrong transaction is a mis-booking, so this surface trades
 * recall for precision and leaves the rest to the picker.
 */
export const CANDIDATE_MIN_CONFIDENCE = 0.6

/** How many probable-underlag candidates to surface at most. */
export const CANDIDATE_LIMIT = 3

/**
 * How many still-unmatched items to score. Bounded rather than paginated:
 * candidates are ranked by confidence and only the strongest few are used, so
 * reading deeper into an old backlog cannot change the answer for a recent
 * transaction.
 */
const CANDIDATE_SCAN_LIMIT = 50

export interface UnderlagCandidate {
  inbox_item_id: string
  document_id: string | null
  merchant_name: string | null
  receipt_date: string | null
  total_amount: number | null
  vat_amount: number | null
  currency: string | null
  /** 0-1 from the shared receipt matcher. */
  confidence: number
  /**
   * Where the amount signal came from: an invoice-style total, or the
   * prominent-amounts fallback for non-invoice documents (bankintyg, avtal).
   * Consumers that act with less human scrutiny (the nightly receipt hunt)
   * must treat 'prominent' as weaker evidence or exclude it.
   */
  amountSource: 'total' | 'prominent'
  /** Swedish reasons the match scored, for display. */
  matchReasons: string[]
  /** Answers already captured for this item, so they travel with it. */
  channelContext: InboxChannelContext | null
}

/** The transaction fields the scorer needs. */
export interface CandidateTransaction {
  id: string
  date: string | null
  description: string | null
  merchant_name?: string | null
  amount: number | null
  currency: string | null
  amount_sek?: number | null
  exchange_rate?: number | null
}

interface ScorableItem {
  id: string
  document_id: string | null
  extracted_data: InvoiceExtractionResult | null
  channel_context: InboxChannelContext | null
  /**
   * The receipt's total in kronor, when a caller has resolved a rate for it.
   *
   * Left undefined by every surface that has not, which keeps the old
   * behaviour exactly: a cross-currency pair stays incomparable rather than
   * being scored on date and merchant alone.
   */
  sek_total?: number | null
}

/** Pull the fields the matcher needs out of an extraction blob. */
function extractionSignals(extracted: InvoiceExtractionResult | null | undefined) {
  return {
    supplier: extracted?.supplier?.name?.trim() || null,
    date: extracted?.invoice?.invoiceDate ?? null,
    total: extracted?.totals?.total ?? null,
    vat: extracted?.totals?.vatAmount ?? null,
    currency: (extracted?.invoice?.currency || 'SEK').toUpperCase(),
    // Non-invoice documents (bankintyg, avtal) carry no total but often show
    // the money amount anyway; the extractor lists those here.
    prominentAmounts: (extracted?.prominentAmounts ?? []).filter(
      (a) => Number.isFinite(a.amount) && a.amount !== 0,
    ),
  }
}

/**
 * Score unmatched items against a transaction and return the strongest few.
 * Pure: the DB read is the caller's job.
 */
export function scoreUnderlagCandidates(
  tx: CandidateTransaction,
  items: ScorableItem[],
): UnderlagCandidate[] {
  if (tx.amount == null || !tx.date) return []

  const txCurrency = (tx.currency ?? 'SEK').toUpperCase()
  const txSek =
    txCurrency === 'SEK'
      ? tx.amount
      : resolveSekAmount(tx.amount, tx.amount_sek, tx.currency, tx.exchange_rate)
  const txDateMs = new Date(tx.date).getTime()
  const txMerchant = tx.merchant_name || tx.description || ''

  const scored: UnderlagCandidate[] = []

  for (const item of items) {
    const sig = extractionSignals(item.extracted_data)
    // An extraction with neither a date nor any amount carries no signal the
    // matcher can use; scoring it returns noise dressed as confidence.
    if (!sig.date && sig.total == null && sig.prominentAmounts.length === 0) continue

    let amountVariance = amountVarianceForMatch(
      sig.total,
      sig.currency,
      // A SEK value only when someone resolved a rate for this receipt.
      // Without one the pair stays incomparable, rather than matching 750 EUR
      // to 750 SEK.
      item.sek_total ?? null,
      tx.amount,
      txCurrency,
      txSek,
    )

    const dateVariance = sig.date
      ? Math.abs((new Date(sig.date).getTime() - txDateMs) / (1000 * 60 * 60 * 24))
      : Number.POSITIVE_INFINITY

    // A document with no invoice-style total (bankintyg, avtal: documentKind
    // "other") but visible amounts falls back to the closest prominent
    // amount. Two guards keep this precision-first: the document's date must
    // agree within the normal tolerance (an avtal listing 349 kr must not
    // match every future 349 kr charge from the same counterparty on amount +
    // merchant alone), and the confidence is discounted below so a fallback
    // can never present as certainty.
    const fallbackMatch =
      sig.total == null && amountVariance == null && dateVariance <= DATE_TOLERANCE_DAYS
        ? bestProminentAmountVariance(
            sig.prominentAmounts,
            sig.currency,
            tx.amount,
            txCurrency,
            txSek,
          )
        : null
    if (fallbackMatch) amountVariance = fallbackMatch.variance

    // No comparable amount means no candidate. calculateMatchConfidence drops
    // the amount signal when it cannot normalise the currencies, which leaves
    // date + merchant carrying the whole normalised score: a same-day receipt
    // from the same merchant then scores 1.0 without anyone having checked
    // that the sums agree. That is a fair ranking hint in the picker, where a
    // human reads both amounts, but here it would hand the agent a "certain"
    // underlag whose total is in another currency. Those still reach the user
    // through the picker; they are just not proposed.
    if (amountVariance == null) continue

    const similarity = sig.supplier ? calculateMerchantSimilarity(sig.supplier, txMerchant) : 0

    // A converted total is judged against the wider bar, because the rate
    // spread is a known error rather than a disagreement about the sum.
    const scoredMatch = calculateMatchConfidence(
      dateVariance,
      amountVariance,
      similarity,
      undefined,
      sig.currency !== txCurrency && item.sek_total != null
        ? CONVERTED_AMOUNT_TOLERANCE_PERCENT
        : undefined,
    )
    let confidence = scoredMatch.confidence
    let matchReasons = scoredMatch.matchReasons
    if (fallbackMatch) {
      confidence = roundOre(confidence * FALLBACK_CONFIDENCE_FACTOR)
      // Name the figure that matched. A bare "Exakt belopp" would reach the
      // agent while total_amount stays null: certainty without a number the
      // agent or the user could check against the document.
      const label = fallbackMatch.label ? ` (${fallbackMatch.label})` : ''
      matchReasons = matchReasons.map((reason) =>
        reason.startsWith('Exakt belopp') || reason.startsWith('Belopp ±')
          ? `${reason} i dokumentet: ${fallbackMatch.amount.toLocaleString('sv-SE')} ${sig.currency}${label}`
          : reason,
      )
    }
    if (confidence < CANDIDATE_MIN_CONFIDENCE) continue

    scored.push({
      inbox_item_id: item.id,
      document_id: item.document_id,
      merchant_name: sig.supplier,
      receipt_date: sig.date,
      total_amount: sig.total,
      vat_amount: sig.vat,
      currency: sig.currency,
      confidence,
      amountSource: fallbackMatch ? 'prominent' : 'total',
      matchReasons,
      channelContext: item.channel_context ?? null,
    })
  }

  scored.sort((a, b) => b.confidence - a.confidence)
  return scored.slice(0, CANDIDATE_LIMIT)
}

/**
 * Find probable underlag for a transaction among the company's unconsumed
 * inbox items.
 *
 * Only unconsumed items are considered: one already booked, already turned into
 * a supplier invoice, or already matched elsewhere belongs to a different
 * economic event, and proposing it here would invite a double booking.
 */
export async function findUnderlagCandidates(
  supabase: SupabaseClient,
  companyId: string,
  tx: CandidateTransaction,
): Promise<UnderlagCandidate[]> {
  if (tx.amount == null || !tx.date) return []

  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id, document_id, extracted_data, channel_context')
    .eq('company_id', companyId)
    .is('matched_transaction_id', null)
    .is('created_journal_entry_id', null)
    .is('created_supplier_invoice_id', null)
    .not('document_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(CANDIDATE_SCAN_LIMIT)

  if (error || !data) return []
  return scoreUnderlagCandidates(tx, data as unknown as ScorableItem[])
}
