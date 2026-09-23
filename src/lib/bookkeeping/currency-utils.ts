/**
 * Currency conversion helpers for journal entry generators.
 *
 * All journal entry line amounts (debit_amount / credit_amount) must be in SEK.
 * These helpers resolve the correct SEK amount from the various currency fields
 * available on invoices, transactions, and supplier invoices.
 */

/**
 * Resolve the SEK amount for a journal entry line, or null when the row carries
 * no honest way to express it in kronor.
 *
 * This is the single conversion ladder for the whole codebase. Prefer it over
 * `resolveSekAmount()` in any code that WRITES to the ledger.
 *
 * Priority:
 * 1. Currency is SEK (or unset, which means SEK) → the amount already IS kronor
 * 2. amountSek is populated → the pre-computed SEK value, rounded to öre
 * 3. A positive exchangeRate is available → amount * exchangeRate, rounded to öre
 * 4. Otherwise → null. A foreign amount with neither a stored SEK value nor a
 *    rate has no SEK value, and saying so is the only honest answer.
 *
 * Why null and not the raw amount: returning the foreign number relabels 100 EUR
 * as 100 SEK. On a booking path every leg is then scaled by the same wrong
 * factor, so the verifikation still balances, no DB trigger fires and nothing
 * errors: a 1 000 EUR sale posts 1 000 kr to 3001 and 250 kr to 2611 instead of
 * 11 500 kr and 2 875 kr at 11,50 SEK/EUR. That understates ruta 05 and ruta 10
 * of the momsdeklaration by the same amount, which is an oriktig uppgift exposed
 * to skattetillägg under SFL 49 kap 4 §. Nothing downstream can detect it,
 * because the wrong number is indistinguishable from a correct one by then.
 *
 * The in-house precedent for refusing instead of guessing is the
 * `match_batch_allocate` RPC (hard-fails with BATCH_FX_RATE_MISSING),
 * `toSekOrThrow()` in supplier-invoice-entries.ts (SI_FX_RATE_MISSING),
 * `itemToSekOrThrow()` in invoice-entries.ts (INVOICE_FX_RATE_MISSING) and
 * lib/reports/supplier-ledger.ts, which skips unconvertible FX rows and counts
 * them in `unconverted_fx_count` rather than faking a 1:1 conversion.
 */
export function resolveSekAmountOrNull(
  amount: number,
  amountSek: number | null | undefined,
  currency: string | null | undefined,
  exchangeRate: number | null | undefined
): number | null {
  if (!currency || currency === 'SEK') {
    return amount
  }

  if (amountSek != null) {
    return Math.round(amountSek * 100) / 100
  }

  if (exchangeRate != null && exchangeRate > 0) {
    return Math.round(amount * exchangeRate * 100) / 100
  }

  return null
}

/**
 * Lenient variant of `resolveSekAmountOrNull()` that falls back to the raw
 * amount when no SEK value can be established.
 *
 * READ-ONLY CODE ONLY. Do not introduce new callers on a path that writes
 * journal entry lines; use `resolveSekAmountOrNull()` and refuse (or skip) when
 * it returns null.
 *
 * The fallback exists for legacy data: rows predating the FX columns genuinely
 * have neither `*_sek` nor an `exchange_rate`, they are overwhelmingly SEK, and
 * a report must still render them rather than blank out a whole ledger. Every
 * remaining caller in `lib/reports/` establishes that the row is convertible
 * BEFORE calling (see the `isFx && !hasRate` checks in ar-ledger.ts,
 * supplier-ledger.ts, ar-reconciliation.ts, supplier-reconciliation.ts and
 * kpi.ts), so for them the fallback is already unreachable and this function is
 * just the shared arithmetic.
 *
 * Behaviour is deliberately unchanged from before the strict sibling existed, so
 * that no existing call site shifts.
 */
export function resolveSekAmount(
  amount: number,
  amountSek: number | null | undefined,
  currency: string | null | undefined,
  exchangeRate: number | null | undefined
): number {
  return resolveSekAmountOrNull(amount, amountSek, currency, exchangeRate) ?? amount
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
