/**
 * Core Receipt Matcher — pure matching utility functions extracted from the
 * receipt-ocr extension so they can be reused by the document matching engine.
 *
 * These are pure functions with no Supabase or extension dependencies.
 */

// Matching configuration (re-exported for consumers)
export const DATE_TOLERANCE_DAYS = 3
export const AMOUNT_TOLERANCE_PERCENT = 0.05
export const MIN_MATCH_CONFIDENCE = 0.4

/**
 * Normalize a merchant name for comparison.
 * Removes special characters, Swedish company suffixes, and extra whitespace.
 */
export function normalizeMerchantName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\såäöé]/g, '') // Remove special chars except Swedish letters
    .replace(/\b(ab|hb|kb|ek|för|stiftelse)\b/g, '') // Remove company suffixes
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Calculate Levenshtein (edit) distance between two strings.
 */
export function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length
  const n = str2.length

  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      )
    }
  }

  return dp[m][n]
}

/**
 * Calculate merchant name similarity using Levenshtein distance and word overlap.
 * Returns a value between 0 (no match) and 1 (exact match).
 */
export function calculateMerchantSimilarity(name1: string, name2: string): number {
  if (!name1 || !name2) return 0

  const n1 = normalizeMerchantName(name1)
  const n2 = normalizeMerchantName(name2)

  // Exact match
  if (n1 === n2) return 1

  // One contains the other
  if (n1.includes(n2) || n2.includes(n1)) return 0.9

  // Word overlap
  const words1 = n1.split(/\s+/)
  const words2 = n2.split(/\s+/)
  const commonWords = words1.filter((w) => words2.includes(w))

  if (commonWords.length > 0) {
    const overlapScore = commonWords.length / Math.max(words1.length, words2.length)
    if (overlapScore >= 0.5) return 0.7 + overlapScore * 0.2
  }

  // Levenshtein similarity
  const distance = levenshteinDistance(n1, n2)
  const maxLength = Math.max(n1.length, n2.length)
  return 1 - distance / maxLength
}

/**
 * Compute the relative amount variance between a bank transaction and an
 * underlag (receipt/invoice) total, currency-aware. Feeds the `amountVariance`
 * argument of calculateMatchConfidence.
 *
 * Returns `null` when the amounts cannot be compared — either there is no
 * underlag total, or the two are in different currencies and the underlag has
 * no SEK value (no FX rate). A null result is the signal for
 * calculateMatchConfidence to drop the amount weight entirely instead of
 * comparing raw magnitudes across currencies — that cross-currency raw compare
 * is exactly what made a 750 EUR receipt falsely match a 750 SEK transaction.
 *
 * Magnitudes are compared (Math.abs) because a bank expense row is negative
 * while an underlag total is positive.
 *
 * @param receiptTotal    underlag total in its own currency (sign-agnostic)
 * @param receiptCurrency underlag currency, e.g. 'EUR'
 * @param receiptSek      underlag total converted to SEK, or null if unknown
 * @param txAmount        transaction amount in its own currency (sign-agnostic)
 * @param txCurrency      transaction currency, e.g. 'SEK'
 * @param txSek           transaction amount in SEK (equals txAmount for SEK rows)
 */
export function amountVarianceForMatch(
  receiptTotal: number | null,
  receiptCurrency: string,
  receiptSek: number | null,
  txAmount: number,
  txCurrency: string,
  txSek: number,
): number | null {
  if (receiptTotal == null) return null
  const absTotal = Math.abs(receiptTotal)
  if (absTotal === 0) return null

  // Same currency → compare raw magnitudes (most reliable, needs no rate).
  if (txCurrency.toUpperCase() === receiptCurrency.toUpperCase()) {
    return Math.abs(Math.abs(txAmount) - absTotal) / absTotal
  }

  // Different currencies → compare in SEK, but only with an SEK value for both.
  if (receiptSek != null && Math.abs(receiptSek) > 0) {
    return Math.abs(Math.abs(txSek) - Math.abs(receiptSek)) / Math.abs(receiptSek)
  }

  // Cross-currency with no rate → not comparable.
  return null
}

/**
 * Calculate a weighted match confidence score from date, amount, and merchant signals.
 * Weights: amount 40%, merchant 35%, date 25%.
 *
 * When merchant similarity is 0, the merchant weight is excluded from the
 * total weight so the confidence is normalized across the active signals only.
 *
 * `amountVariance` may be `null` when the candidate and the underlag are in
 * different currencies and no FX rate was available to normalise them. In that
 * case the amount signal is dropped entirely (same treatment as a missing
 * merchant) rather than comparing raw magnitudes across currencies — that is
 * what made a 750 EUR receipt falsely match a 750 SEK transaction.
 */
export function calculateMatchConfidence(
  dateVariance: number,
  amountVariance: number | null,
  merchantSimilarity: number,
  dateTolerance: number = DATE_TOLERANCE_DAYS,
  amountTolerance: number = AMOUNT_TOLERANCE_PERCENT
): { confidence: number; matchReasons: string[] } {
  const matchReasons: string[] = []
  let totalWeight = 0
  let weightedScore = 0

  // Date score (weight: 25%)
  const dateScore = Math.max(0, 1 - dateVariance / dateTolerance)
  if (dateScore >= 0.8) {
    matchReasons.push(dateVariance === 0 ? 'Exakt datum' : `Datum ±${Math.round(dateVariance)} dagar`)
  }
  weightedScore += dateScore * 0.25
  totalWeight += 0.25

  // Amount score (weight: 40%) — only counted when the amounts are comparable
  // (same currency, or both normalisable to SEK).
  if (amountVariance != null) {
    const amountScore = Math.max(0, 1 - amountVariance / amountTolerance)
    if (amountVariance < 0.01) {
      matchReasons.push('Exakt belopp')
    } else if (amountVariance < amountTolerance) {
      matchReasons.push(`Belopp ±${Math.round(amountVariance * 100)}%`)
    }
    weightedScore += amountScore * 0.4
    totalWeight += 0.4
  }

  // Merchant score (weight: 35%) — only counted when there's data
  if (merchantSimilarity > 0) {
    if (merchantSimilarity >= 0.9) {
      matchReasons.push('Handlare matchar')
    } else if (merchantSimilarity >= 0.6) {
      matchReasons.push('Trolig handlarmatch')
    }
    weightedScore += merchantSimilarity * 0.35
    totalWeight += 0.35
  }

  const confidence = totalWeight > 0 ? weightedScore / totalWeight : 0

  return {
    confidence: Math.round(confidence * 100) / 100,
    matchReasons,
  }
}
