/**
 * The sentence above the table under "Förslag till resultatdisposition" when
 * the board has written none of its own (ÅRL 6 kap. 2 § första stycket).
 * It states what the table states: with a proposed dividend, the dividend and
 * what is carried forward; without one, that the result is carried forward.
 * The amounts are whole kronor, like the table (BFNAR 2016:10 punkt 3.9), and
 * the proposal covers the sum of fritt eget kapital (punkt 5.8), so the
 * carried-forward amount is that sum less the dividend.
 *
 * The report, the iXBRL and the editor all read the sentence from here: the
 * editor saves no text of its own while its text is this sentence, so the
 * sentence keeps following the amounts when the dividend changes.
 */
import { formatPdfKronor } from './pdf-format'

/** The sentence when no dividend is proposed, as every report has printed it. */
export const NO_DIVIDEND_DISPOSITION_TEXT = 'Styrelsen föreslår att årets resultat balanseras i ny räkning.'

export interface DispositionTextAmounts {
  proposed_dividend: number
  /** The sum at the meeting's disposal: fritt eget kapital. */
  total: number
}

/**
 * The dividend the iXBRL table states (build-input.ts): whole kronor, never
 * below zero. The sentence states the same amount, and what is carried
 * forward is the total less it, so the two never differ by a rounded krona.
 */
export function statedDividend(proposedDividend: number): number {
  return Math.max(0, Math.round(proposedDividend))
}

export function defaultDispositionText(amounts: DispositionTextAmounts): string {
  const dividend = statedDividend(amounts.proposed_dividend)
  if (!(dividend > 0)) return NO_DIVIDEND_DISPOSITION_TEXT
  return (
    `Styrelsen föreslår att vinstmedlen disponeras så att ${formatPdfKronor(dividend)} kr delas ut ` +
    `och ${formatPdfKronor(amounts.total - dividend)} kr balanseras i ny räkning.`
  )
}

/** The dividend sentence as defaultDispositionText writes it, for any amounts. */
const DIVIDEND_SENTENCE =
  /^Styrelsen föreslår att vinstmedlen disponeras så att \d[\d\s]* kr delas ut och -?\d[\d\s]* kr balanseras i ny räkning\.$/

/**
 * Whether a text is a sentence this module writes, for whatever amounts: it
 * states amounts, not the board's words, so it is written again from the
 * amounts it stands beside. The editor used to save the sentence it showed as
 * if the user had typed it, and a report text copied back through the API
 * does the same.
 */
export function isGeneratedDispositionText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed === NO_DIVIDEND_DISPOSITION_TEXT || DIVIDEND_SENTENCE.test(trimmed)
}

/**
 * The sentence the report prints: the board's own text, else the sentence
 * for these amounts. A stored sentence that already says it is kept as
 * stored, so the content hash of such a report stays.
 */
export function dispositionText(stored: string | undefined, amounts: DispositionTextAmounts): string {
  const generated = defaultDispositionText(amounts)
  if (stored === undefined) return generated
  if (isGeneratedDispositionText(stored) && stored.trim() !== generated) return generated
  return stored
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
