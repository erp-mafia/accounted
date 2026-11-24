/**
 * The wording of the board's proposal for the disposition of the result when
 * the board has written none of its own (ÅRL 6 kap. 2 § första stycket): the
 * sentence above the table under "Förslag till resultatdisposition", and the
 * board_proposal_text the årsstämma decides on.
 *
 * It lives with the meetings, which the årsredovisning may read, so both read
 * one wording: the årsredovisning formats the amounts and builds the sentence
 * (bokslut/arsredovisning/disposition-text.ts), the årsstämma template knows
 * a generated sentence from the board's own words.
 */

/** The sentence when no dividend is proposed, as every report has printed it. */
export const NO_DIVIDEND_DISPOSITION_TEXT = 'Styrelsen föreslår att årets resultat balanseras i ny räkning.'

/**
 * The dividend the iXBRL table states (ixbrl/build-input.ts): whole kronor
 * (BFNAR 2016:10 punkt 3.9), never below zero. The sentence states the same
 * amount, and what is carried forward is the total less it, so the two never
 * differ by a rounded krona.
 */
export function statedDividend(proposedDividend: number): number {
  return Math.max(0, Math.round(proposedDividend))
}

/** The dividend sentence, for amounts already written as whole kronor. */
export function dividendDispositionSentence(dividendKronor: string, carriedForwardKronor: string): string {
  return (
    `Styrelsen föreslår att vinstmedlen disponeras så att ${dividendKronor} kr delas ut ` +
    `och ${carriedForwardKronor} kr balanseras i ny räkning.`
  )
}

/** The dividend sentence as dividendDispositionSentence writes it, for any amounts. */
const DIVIDEND_SENTENCE =
  /^Styrelsen föreslår att vinstmedlen disponeras så att \d[\d\s]* kr delas ut och -?\d[\d\s]* kr balanseras i ny räkning\.$/

/**
 * Whether a text is a generated sentence, for whatever amounts: it states
 * amounts, not the board's words, so it is written again from the amounts it
 * stands beside. The editor used to save the sentence it showed as if the
 * user had typed it, and a report text copied back through the API does the
 * same.
 */
export function isGeneratedDispositionText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed === NO_DIVIDEND_DISPOSITION_TEXT || DIVIDEND_SENTENCE.test(trimmed)
}

/**
 * For a reader without the report's amounts (the årsstämma template before
 * any version exists): the board's own text; else, without a dividend, the
 * sentence every report prints; else null, since the dividend sentence needs
 * the free equity only the report has.
 */
export function proposalTextWithoutAmounts(stored: string | null | undefined, proposedDividend: number): string | null {
  if (stored != null && !isGeneratedDispositionText(stored)) return stored
  return statedDividend(proposedDividend) > 0 ? null : NO_DIVIDEND_DISPOSITION_TEXT
}
