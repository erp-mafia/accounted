import type { QuoteStatus } from '@/types'

/** What the UI and API report for a quote: the stored decision, or expired. */
export type EffectiveQuoteStatus = QuoteStatus | 'expired'

/**
 * "Expired" is derived, never stored: an open quote whose valid_until has
 * passed. Extending valid_until therefore un-expires it with no cron and no
 * status write. Accepted and declined quotes never expire.
 */
export function isQuoteExpired(
  quote: { quote_status?: string | null; valid_until?: string | null },
  today: string = new Date().toISOString().split('T')[0],
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

/** Quote numbers are allocated at insert; this mirrors generate_quote_number's format for previews. */
export function formatQuoteNumber(n: number): string {
  return `OF-${String(n).padStart(3, '0')}`
}
