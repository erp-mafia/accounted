/**
 * Rank unbooked bank rows as the payment of one underlag (an inbox item's
 * extracted document): the one ranking behind both inbox surfaces that offer
 * a bank row for an underlag, the match picker ("Matcha mot transaktion") and
 * Bokför direkt, through useUnderlagBankCandidates.
 *
 * The score is lib/documents/core-receipt-matcher's: amount, date and the
 * supplier's name against the row's merchant/description. Amounts compare
 * currency-aware: same currency raw, otherwise through SEK (the row's stored
 * SEK value, the underlag's via the Riksbank rate the caller fetched). A
 * foreign underlag with no rate yet has no amount signal rather than a wrong
 * one (750 EUR is not 750 SEK). A document with no total (bankintyg, avtal)
 * scores against its closest prominent amount, discounted, so a printed
 * figure never presents as the certainty a real total gives.
 *
 * No server-only imports: the client components import it.
 */
import {
  FALLBACK_CONFIDENCE_FACTOR,
  amountVarianceForMatch,
  bestProminentAmountVariance,
  calculateMatchConfidence,
  calculateMerchantSimilarity,
} from '@/lib/documents/core-receipt-matcher'
import { bookDirectDocumentCurrency } from '@/lib/bookkeeping/book-direct-prefill'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'
import type { InvoiceExtractionResult } from '@/types'

/**
 * Date tolerance used only for RANKING (nothing is filtered by date). Far
 * wider than the receipt matcher's tight +-3 days, so a payment landing weeks
 * or months after the invoice still earns partial date credit and the true
 * match floats to the top, instead of every candidate collapsing to "Svag match".
 */
export const UNDERLAG_MATCH_DATE_TOLERANCE_DAYS = 120

/** An unbooked bank row as /api/transactions?unmatched=true answers it. */
export interface UnbookedBankRow {
  id: string
  date: string
  description: string | null
  merchant_name?: string | null
  amount: number
  currency: string | null
  amount_sek?: number | null
  exchange_rate?: number | null
}

/** What an underlag says about the payment it expects. */
export interface UnderlagPaymentFacts {
  /** The document total, or null when there is none or it is only a promoted prominent amount. */
  total: number | null
  /** The document currency, upper-case, SEK when absent. */
  currency: string
  /** The extracted invoice date when it parses. */
  invoiceDate: string | null
  supplier: string | null
  /** Printed amounts, used only when there is no total. */
  prominentAmounts: { amount: number; label: string | null }[]
  /**
   * Which way the money went: out for a purchase (an invoice, a receipt), in
   * for a credit note or a refund (a total below zero). Null when the
   * document says neither; then a row of either sign may be its payment.
   */
  direction: 'out' | 'in' | null
}

function paymentDirection(extracted: InvoiceExtractionResult | null): UnderlagPaymentFacts['direction'] {
  const kind = extracted?.documentKind
  if (kind === 'credit_note') return 'in'
  if (kind !== 'supplier_invoice' && kind !== 'receipt') return null
  const total = extracted?.totals?.total
  return typeof total === 'number' && total < 0 ? 'in' : 'out'
}

export function underlagPaymentFacts(extracted: InvoiceExtractionResult | null): UnderlagPaymentFacts {
  // A total promoted from the document's single prominent amount (totalSource
  // 'prominent') is fallback-grade evidence, not an invoice total: it scores
  // through the discounted fallback path. A user-edited total has the stamp
  // cleared and counts at full weight.
  const total = extracted?.totalSource === 'prominent' ? null : (extracted?.totals?.total ?? null)
  const rawDate = extracted?.invoice?.invoiceDate ?? null
  const invoiceDate = rawDate && !Number.isNaN(new Date(rawDate).getTime()) ? rawDate : null
  return {
    total,
    currency: bookDirectDocumentCurrency(extracted),
    invoiceDate,
    supplier: extracted?.supplier?.name ?? null,
    prominentAmounts:
      total == null
        ? (extracted?.prominentAmounts ?? []).filter((a) => Number.isFinite(a.amount) && a.amount !== 0)
        : [],
    direction: paymentDirection(extracted),
  }
}

/** The underlag total in kronor: itself on SEK, through the fetched rate otherwise, else null. */
export function underlagTotalSek(facts: UnderlagPaymentFacts, fxRate: number | null): number | null {
  if (facts.total == null) return null
  if (facts.currency === 'SEK') return facts.total
  if (fxRate != null) return roundOre(facts.total * fxRate)
  return null
}

export interface RankedBankRow<T extends UnbookedBankRow = UnbookedBankRow> {
  row: T
  /** The row's currency, upper-case, SEK when absent. */
  currency: string
  /** SEK equivalent of a foreign row, for the "ca ... kr" hint; null on SEK rows. */
  amountSek: number | null
  confidence: number
  reasons: string[]
}

/** A row whose money went the way the underlag says: a purchase is never paid by money coming in. */
function sameDirection(row: UnbookedBankRow, direction: UnderlagPaymentFacts['direction']): boolean {
  if (direction === null) return true
  return direction === 'out' ? row.amount < 0 : row.amount > 0
}

/**
 * Best match first. `today` anchors the date score when the underlag has no
 * date. A row going the other way (money in for a purchase, money out for a
 * credit note) is not a candidate at all.
 */
export function rankBankRowsForUnderlag<T extends UnbookedBankRow>(
  rows: readonly T[],
  facts: UnderlagPaymentFacts,
  fxRate: number | null,
  today: Date = new Date(),
): RankedBankRow<T>[] {
  const totalSek = underlagTotalSek(facts, fxRate)
  const anchor = facts.invoiceDate ? new Date(facts.invoiceDate) : today
  const ranked = rows.filter((row) => sameDirection(row, facts.direction)).map((row) => {
    const currency = (row.currency ?? 'SEK').toUpperCase()
    const rowSek =
      currency === 'SEK'
        ? row.amount
        : resolveSekAmount(row.amount, row.amount_sek ?? null, row.currency, row.exchange_rate ?? null)

    // Null when uncomparable: the matcher then drops the amount signal.
    let amountVariance = amountVarianceForMatch(facts.total, facts.currency, totalSek, row.amount, currency, rowSek)
    const fallback =
      facts.total == null && facts.prominentAmounts.length > 0
        ? bestProminentAmountVariance(facts.prominentAmounts, facts.currency, row.amount, currency, rowSek)
        : null
    if (fallback) amountVariance = fallback.variance

    const dateVariance = Math.abs((new Date(row.date).getTime() - anchor.getTime()) / (1000 * 60 * 60 * 24))
    const merchant = row.merchant_name || row.description || ''
    const similarity = facts.supplier ? calculateMerchantSimilarity(facts.supplier, merchant) : 0
    const scored = calculateMatchConfidence(dateVariance, amountVariance, similarity, UNDERLAG_MATCH_DATE_TOLERANCE_DAYS)
    return {
      row,
      currency,
      amountSek: currency === 'SEK' ? null : roundOre(rowSek),
      confidence: fallback ? roundOre(scored.confidence * FALLBACK_CONFIDENCE_FACTOR) : scored.confidence,
      reasons: scored.matchReasons,
    }
  })
  return ranked.sort((a, b) => b.confidence - a.confidence)
}
