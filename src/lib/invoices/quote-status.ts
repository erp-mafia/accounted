import type { QuoteStatus } from '@/types'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { isZeroOre, roundOre, sumOre } from '@/lib/money'

/** What the UI and API report for a quote: the stored decision, or expired. */
export type EffectiveQuoteStatus = QuoteStatus | 'expired'

/** An invoice converted from a quote (invoices.converted_from_id = the quote). */
export interface QuoteConversionRow {
  status: string
  subtotal?: number | string | null
}

/** How much of a quote has been invoiced. Amounts are excl. VAT, in the quote's currency. */
export interface QuoteInvoicingProgress {
  /** The quote's own net total. */
  quoteSubtotal: number
  /** Net of the live (non-cancelled) invoices converted from the quote. */
  invoiced: number
  /** Left to invoice, never below zero. */
  remaining: number
  /** Live invoices converted from the quote. */
  invoiceCount: number
  /** Something was invoiced and nothing is left (crm#1196). */
  fullyInvoiced: boolean
}

/**
 * Invoiced so far and remaining on a quote, derived from the invoices made
 * from it: there is no counter to keep in step. A quote can be invoiced in
 * parts (crm#1196), so it is done once fully invoiced, not once any invoice
 * exists; a cancelled invoice counts for nothing and frees its part again.
 * The database refuses a conversion that would invoice more than the quote
 * (invoices_converted_source_guard), so `invoiced` only exceeds the quote
 * when a converted draft was edited upwards.
 */
export function quoteInvoicingProgress(
  quote: { subtotal?: number | string | null },
  conversions?: ReadonlyArray<QuoteConversionRow> | null,
): QuoteInvoicingProgress {
  const live = (conversions ?? []).filter((row) => row.status !== 'cancelled')
  const quoteSubtotal = roundOre(Number(quote.subtotal ?? 0))
  const invoiced = sumOre(live.map((row) => Number(row.subtotal ?? 0)))
  const remaining = Math.max(0, roundOre(quoteSubtotal - invoiced))
  return {
    quoteSubtotal,
    invoiced,
    remaining,
    invoiceCount: live.length,
    fullyInvoiced: live.length > 0 && isZeroOre(remaining),
  }
}

/**
 * "Expired" is derived, never stored: an open quote whose valid_until has
 * passed. Extending valid_until therefore un-expires it with no cron and no
 * status write. Accepted and declined quotes never expire.
 */
export function isQuoteExpired(
  quote: { quote_status?: string | null; valid_until?: string | null },
  today: string = todayIsoStockholm(),
): boolean {
  return quote.quote_status === 'open' && !!quote.valid_until && quote.valid_until < today
}

export function effectiveQuoteStatus(
  quote: { quote_status?: string | null; valid_until?: string | null },
  today?: string,
): EffectiveQuoteStatus | null {
  if (!quote.quote_status) return null
  if (isQuoteExpired(quote, today)) return 'expired'
  return quote.quote_status as QuoteStatus
}

/**
 * An accepted quote is done once a kundorder created from it lives
 * (sales_orders.source_invoice_id; the order is invoiced from then on), or
 * once the live invoices converted from it (invoices.converted_from_id) cover
 * the whole quote. A quote can be invoiced in parts (crm#1196), so a partly
 * invoiced quote still has a next step: invoicing the rest. A cancelled
 * follow-up frees the quote again. The same rules convertToInvoice and the
 * conversion guard enforce.
 */
export function quoteHasLiveFollowUp(quote: {
  subtotal?: number | string | null
  conversions?: ReadonlyArray<QuoteConversionRow> | null
  orders?: ReadonlyArray<{ status: string }> | null
}): boolean {
  const liveOrder = (quote.orders ?? []).some((row) => row.status !== 'cancelled')
  return liveOrder || quoteInvoicingProgress(quote, quote.conversions).fullyInvoiced
}

/** Quote numbers are allocated at insert; this mirrors generate_quote_number's format for previews. */
export function formatQuoteNumber(n: number): string {
  return `OF-${String(n).padStart(3, '0')}`
}

/**
 * A quote that has not reached the customer: still status 'draft'. A quote
 * has two separate axes, delivery (status: draft, sent, cancelled) and the
 * customer's decision (quote_status), and only the delivery axis says whether
 * the customer has seen it. Accepting or converting such a quote is allowed
 * (a yes given by phone, or a PDF mailed by hand), but it is never the next
 * step the page offers first: sending is (crm#1202).
 */
export function isUnsentQuote(quote: {
  document_type?: string | null
  status?: string | null
  quote_status?: string | null
}): boolean {
  return quote.document_type === 'quote' && quote.status === 'draft' && !!quote.quote_status
}

/**
 * The next step a quote's page offers is sending it: unsent, and the customer
 * has not said yes. Accept, convert and order stay reachable behind a confirm
 * (crm#1202: an order made from an unsent quote, when the user meant to send
 * it). Once accepted, converting is the natural next step, sent or not.
 */
export function quoteAwaitsSending(quote: Parameters<typeof isUnsentQuote>[0]): boolean {
  return isUnsentQuote(quote) && quote.quote_status !== 'accepted'
}

/**
 * What a quote's status line says: the decision or the derived expiry, and
 * "unsent" for an open quote that never left (otherwise it reads "Öppen", as
 * if the customer were already weighing it). Expiry outranks unsent: an
 * expired offer needs a new valid_until before it is worth sending.
 */
export type QuoteDisplayStatus = EffectiveQuoteStatus | 'unsent'

export function quoteDisplayStatus(
  quote: {
    document_type?: string | null
    status?: string | null
    quote_status?: string | null
    valid_until?: string | null
  },
  today?: string,
): QuoteDisplayStatus | null {
  const effective = effectiveQuoteStatus(quote, today)
  if (effective === 'open' && isUnsentQuote(quote)) return 'unsent'
  return effective
}
