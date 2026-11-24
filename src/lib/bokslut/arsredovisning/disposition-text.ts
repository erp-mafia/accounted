/**
 * The sentence above the table under "Förslag till resultatdisposition" when
 * the board has written none of its own (ÅRL 6 kap. 2 § första stycket).
 * It states what the table states: with a proposed dividend, the dividend and
 * what is carried forward; without one, that the result is carried forward.
 * The amounts are whole kronor, like the table (BFNAR 2016:10 punkt 3.9), and
 * the proposal covers the sum of fritt eget kapital (punkt 5.8), so the
 * carried-forward amount is that sum less the dividend.
 *
 * The report, the iXBRL and the editor all read the sentence from
 * here, its wording from the meetings (bolaget/meetings/disposition-sentence.ts,
 * which the årsstämma template reads too): the editor saves no text of its
 * own while its text is this sentence, so the sentence keeps following the
 * amounts when the dividend changes.
 */
import {
  NO_DIVIDEND_DISPOSITION_TEXT,
  dividendDispositionSentence,
  isGeneratedDispositionText,
  statedDividend,
} from '@/lib/bolaget/meetings/disposition-sentence'
import { formatPdfKronor } from './pdf-format'

export { NO_DIVIDEND_DISPOSITION_TEXT, isGeneratedDispositionText, statedDividend }

export interface DispositionTextAmounts {
  proposed_dividend: number
  /** The sum at the meeting's disposal: fritt eget kapital. */
  total: number
}

export function defaultDispositionText(amounts: DispositionTextAmounts): string {
  const dividend = statedDividend(amounts.proposed_dividend)
  if (!(dividend > 0)) return NO_DIVIDEND_DISPOSITION_TEXT
  return dividendDispositionSentence(formatPdfKronor(dividend), formatPdfKronor(amounts.total - dividend))
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
