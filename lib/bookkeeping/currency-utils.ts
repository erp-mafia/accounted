/**
 * Currency conversion helpers for journal entry generators.
 *
 * All journal entry line amounts (debit_amount / credit_amount) must be in SEK.
 * These helpers resolve the correct SEK amount from the various currency fields
 * available on invoices, transactions, and supplier invoices.
 */

/**
 * Resolve the SEK amount for a journal entry line.
 *
 * Priority:
 * 1. If currency is SEK → return amount as-is
 * 2. If amountSek is populated → return it (pre-computed SEK value)
 * 3. If exchangeRate is available → compute amount * exchangeRate
 * 4. Fallback → return amount (legacy data safety: assumes SEK)
 */
export function resolveSekAmount(
  amount: number,
  amountSek: number | null | undefined,
  currency: string | null | undefined,
  exchangeRate: number | null | undefined
): number {
  if (!currency || currency === 'SEK') {
    return amount
  }

  if (amountSek != null) {
    return Math.round(amountSek * 100) / 100
  }

  if (exchangeRate != null && exchangeRate > 0) {
    return Math.round(amount * exchangeRate * 100) / 100
  }

  // Fallback: legacy data without conversion info: return original amount
  return amount
}

/**
 * Build currency metadata fields for a journal entry line.
 * Returns an empty object for SEK transactions (no metadata needed).
 */
export function buildCurrencyMetadata(
  currency: string | null | undefined,
  amountInCurrency: number | null | undefined,
  exchangeRate: number | null | undefined
): {
  currency?: string
  amount_in_currency?: number
  exchange_rate?: number
} {
  if (!currency || currency === 'SEK') {
    return {}
  }

  return {
    ...(currency ? { currency } : {}),
    ...(amountInCurrency != null ? { amount_in_currency: amountInCurrency } : {}),
    ...(exchangeRate != null && exchangeRate > 0 ? { exchange_rate: exchangeRate } : {}),
  }
}
