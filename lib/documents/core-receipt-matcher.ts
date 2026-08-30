/**
 * Core Receipt Matcher: pure matching utility functions extracted from the
 * receipt-ocr extension so they can be reused by the document matching engine.
 *
 * These are pure functions with no Supabase or extension dependencies.
 */

// Matching configuration (re-exported for consumers)
/**
 * How far a receipt's date may sit from the bank's before the date stops
 * counting as agreement.
 *
 * Ten days, not three. A card purchase settles days after it happens, an
 * international one routinely a week later, and a forwarded receipt carries
 * the date of the purchase while the statement carries the date of the
 * posting. At three days the signal scored zero for ordinary, correct pairs
 * and took a quarter of the weight down with it: a receipt matching to within
 * 1% from a merchant the matcher recognised still capped at 0.62, under every
 * threshold that decides anything.
 *
 * The date remains real evidence at this width. A receipt from March still
 * disagrees with a purchase in September.
 */
export const DATE_TOLERANCE_DAYS = 10
export const AMOUNT_TOLERANCE_PERCENT = 0.05

/**
 * Tolerance for a total that had to be converted into kronor first.
 *
 * A same-currency comparison is two readings of one number, so 5% is generous.
 * A converted one carries a second, known error: Riksbanken publishes a mid
 * rate and a card issuer charges its own, typically a point or two away, on a
 * settlement day that need not be the receipt's. Holding both to the same bar
 * treats a rate spread as if it were a disagreement about the sum. Measured
 * against real statements, the spread ran 1.2% to 3%.
 */
export const CONVERTED_AMOUNT_TOLERANCE_PERCENT = 0.09
export const MIN_MATCH_CONFIDENCE = 0.4

/** Default weight of the amount signal in calculateMatchConfidence. */
export const AMOUNT_WEIGHT = 0.4

/**
 * Reduced amount weight when the amount did not come from an invoice-style
 * total but from a prominentAmounts fallback (bankintyg, avtal, contracts).
 * Such an amount is one of possibly several figures printed on the document
 * rather than "what the buyer pays", so an agreement is real evidence but
 * weaker than a total agreeing.
 */
export const FALLBACK_AMOUNT_WEIGHT = 0.3

/**
 * Normalize a merchant name for comparison.
 * Removes special characters, Swedish company suffixes, and extra whitespace.
 *
 * FROZEN. This is not merely a helper: `normalizeCounterpartyName`
 * (lib/bookkeeping/counterparty-templates.ts) ends in this function, and its
 * output is PERSISTED as `categorization_templates.counterparty_name` under
 * UNIQUE (company_id, counterparty_name), with a hand-written SQL mirror
 * `public.normalize_counterparty_key()` that the ledger-context RPC recomputes
 * at query time. Change this and stored keys stop equalling computed ones: the
 * konteringskarta join misses, learned vat_treatment degrades to history, and
 * `insertOrUpdateTemplate` silently inserts a SECOND row per merchant, orphaning
 * the occurrence counts instead of migrating them.
 *
 * To improve MATCHING, edit `normalizeForMatch` below, which nothing persists.
 * To improve the canonical KEY, it is a three-part atomic change: this function
 * + CREATE OR REPLACE of the SQL mirror + a backfill/merge migration over
 * categorization_templates, with tests/pg/ledger-usage-stats-rpc.pg.test.ts
 * extended in the same commit.
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
 * Legal-form tokens that carry no identity. Deliberately wider than the frozen
 * key normalizer's list: a receipt says "Adobe Systems Software Ireland Ltd"
 * where the bank says "Adobe", and only the matcher needs to see through that.
 */
const LEGAL_FORM_TOKENS =
  /\b(ab|hb|kb|ek|för|stiftelse|inc|llc|ltd|limited|gmbh|oy|oyj|ap|aps|pbc|plc|sarl|bv|nv|corp|corporation|company|filial|int|international)\b/g

/**
 * Noise the Swedish card rails staple onto a merchant, observed in production:
 * `Ryde Sweden AB  K8066 Kortköp/uttag`, `Kortköp 260612 Prime Video-*NL5EK5W`,
 * `ELGIGANTEN S/25-07-14`, `Qstar Lilla Edet 6531 K8781 Kortköp/uttag`.
 */
const CARD_TOKEN = /\bk\d{4}\b/g
const CARD_VERB = /\bkort(kop|kop\/uttag)?\b|\buttag\b/g
/**
 * Swedish words a bank statement puts around a merchant name that are not part
 * of it. "Utlägg Norwegian" is an expense reimbursement for a Norwegian
 * ticket, not a company called Utlägg: leaving the word in cost the pair its
 * token-subset match and dropped merchant similarity to 0.18, which was enough
 * to keep an exact 1 998 kr match from ever being proposed.
 */
const PAYMENT_NOISE = /\butl[aä]gg\b|\b[oö]verf[oö]ring\b|\bvia internet\b|\bbg-?bet\b|\bautogiro\b/g
const CARD_DATE_PREFIX = /^\s*kortkop\s+\d{6}\s*/
const TRAILING_DATE = /\s*\/?\s*\d{2}-\d{2}-\d{2}\s*$/
/**
 * Reference numbers, which banks glue straight onto the name
 * ("GOOGLE ADS8047863617"), so this deliberately has no word boundary. Runs of
 * three digits or fewer stay: they are often part of the identity
 * ("Rusta Lindingö 135", "7-Eleven").
 */
const LONG_DIGIT_RUN = /\d{4,}/g
const DOMAIN_TAIL = /\.(com|se|io|ai|co|net|org|nu|dk|no|fi|de|uk)\b/g

/**
 * Fold a merchant string down to the part that actually identifies it, for
 * SIMILARITY ONLY. Nothing persists this, so it can be aggressive where the
 * frozen key normalizer must not be.
 *
 * Aggressive folding is safe here precisely because it is applied to BOTH sides
 * of every comparison: an over-eager fold that turns "Boeing" into "boing" does
 * so for the receipt and the bank row alike, so the pair still matches. The only
 * real risk is two genuinely different merchants colliding, which the amount and
 * date signals then have to disagree with.
 */
export function normalizeForMatch(name: string): string {
  let s = name.toLowerCase()

  // Banks disagree about diacritics: one writes "kött", another transliterates
  // to "koett", a third mangles the encoding into "LINDING??". Fold all three
  // to the same base letters so they stop being three different merchants.
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  s = s.replace(/\?{2,}|�/g, ' ')
  s = s.replace(/oe/g, 'o').replace(/ae/g, 'a').replace(/aa/g, 'a')

  // A processor marker hides the merchant on one side or the other:
  // GOOGLE*PLAY puts it first, K*IKEA GALLE puts it second. Keep both.
  s = s.replace(/[*_]+/g, ' ')

  s = s.replace(CARD_DATE_PREFIX, ' ')
  s = s.replace(TRAILING_DATE, ' ')
  s = s.replace(CARD_TOKEN, ' ')
  s = s.replace(CARD_VERB, ' ')
  s = s.replace(PAYMENT_NOISE, ' ')
  s = s.replace(DOMAIN_TAIL, ' ')
  s = s.replace(/\bwww\b/g, ' ')

  // Punctuation to space rather than nothing, so "Word,and" stays two tokens.
  s = s.replace(/[^\w\s]/g, ' ')
  s = s.replace(LONG_DIGIT_RUN, ' ')
  s = s.replace(LEGAL_FORM_TOKENS, ' ')

  return s.replace(/\s+/g, ' ').trim()
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

  // Matching-only folding: sees through card tokens, processor stars,
  // transliterated diacritics and legal forms, none of which change identity.
  const n1 = normalizeForMatch(name1)
  const n2 = normalizeForMatch(name2)
  if (!n1 || !n2) return 0

  // Exact match
  if (n1 === n2) return 1

  // One contains the other. Also covers the bank's fixed-width truncation
  // ("apple com bi" inside "apple com bill"), which is a prefix by nature.
  if (n1.includes(n2) || n2.includes(n1)) return 0.9

  const words1 = n1.split(/\s+/).filter(Boolean)
  const words2 = n2.split(/\s+/).filter(Boolean)
  const set1 = new Set(words1)
  const set2 = new Set(words2)
  const commonWords = words1.filter((w) => set2.has(w))

  // Every token of the shorter name appears in the longer one: "Adobe" against
  // "Adobe Systems Software Ireland", or a receipt's legal name against the
  // bank's trading name. Scored level with substring containment because it is
  // the same claim, made token-wise instead of character-wise.
  const smaller = set1.size <= set2.size ? set1 : set2
  const larger = smaller === set1 ? set2 : set1
  if (smaller.size > 0 && [...smaller].every((w) => larger.has(w))) return 0.9

  // Word overlap
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
 * Returns `null` when the amounts cannot be compared: either there is no
 * underlag total, or the two are in different currencies and the underlag has
 * no SEK value (no FX rate). A null result is the signal for
 * calculateMatchConfidence to drop the amount weight entirely instead of
 * comparing raw magnitudes across currencies: that cross-currency raw compare
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
 * Fallback amount variance for documents with no invoice-style total but one
 * or more prominent amounts (bankintyg "Insatt belopp", an agreement's
 * "Engångspris", ...). Tries each amount against the transaction and returns
 * the smallest variance, or null when none is comparable.
 *
 * Same-currency only by construction: prominent amounts never carry a resolved
 * SEK value, so a cross-currency pair stays incomparable (receiptSek = null in
 * amountVarianceForMatch) exactly like a cross-currency total without a rate.
 *
 * Callers that score a fallback variance should pass FALLBACK_AMOUNT_WEIGHT to
 * calculateMatchConfidence: one of several printed figures agreeing is weaker
 * evidence than the document's total agreeing.
 */
export function bestProminentAmountVariance(
  amounts: readonly number[],
  receiptCurrency: string,
  txAmount: number,
  txCurrency: string,
  txSek: number,
): number | null {
  let best: number | null = null
  for (const amount of amounts) {
    if (!Number.isFinite(amount)) continue
    const variance = amountVarianceForMatch(
      amount,
      receiptCurrency,
      null,
      txAmount,
      txCurrency,
      txSek,
    )
    if (variance != null && (best == null || variance < best)) best = variance
  }
  return best
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
 * merchant) rather than comparing raw magnitudes across currencies: that is
 * what made a 750 EUR receipt falsely match a 750 SEK transaction.
 */
export function calculateMatchConfidence(
  dateVariance: number,
  amountVariance: number | null,
  merchantSimilarity: number,
  dateTolerance: number = DATE_TOLERANCE_DAYS,
  amountTolerance: number = AMOUNT_TOLERANCE_PERCENT,
  // FALLBACK_AMOUNT_WEIGHT when the variance came from prominentAmounts
  // rather than an invoice-style total.
  amountWeight: number = AMOUNT_WEIGHT
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

  // Amount score (weight: 40%, reduced for prominent-amount fallbacks): only
  // counted when the amounts are comparable (same currency, or both
  // normalisable to SEK).
  if (amountVariance != null) {
    const amountScore = Math.max(0, 1 - amountVariance / amountTolerance)
    if (amountVariance < 0.01) {
      matchReasons.push('Exakt belopp')
    } else if (amountVariance < amountTolerance) {
      matchReasons.push(`Belopp ±${Math.round(amountVariance * 100)}%`)
    }
    weightedScore += amountScore * amountWeight
    totalWeight += amountWeight
  }

  // Merchant score (weight: 35%): only counted when there's data
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
