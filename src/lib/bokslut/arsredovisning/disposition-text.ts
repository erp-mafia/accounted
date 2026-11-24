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
  carried_forward: number
}

export function defaultDispositionText(amounts: DispositionTextAmounts): string {
  if (!(amounts.proposed_dividend > 0)) return NO_DIVIDEND_DISPOSITION_TEXT
  return (
    `Styrelsen föreslår att vinstmedlen disponeras så att ${formatPdfKronor(amounts.proposed_dividend)} kr delas ut ` +
    `och ${formatPdfKronor(amounts.carried_forward)} kr balanseras i ny räkning.`
  )
}

/**
 * The sentence the report prints: the stored text, unless there is none or
 * it is the no-dividend sentence beside a proposed dividend. The editor used
 * to save the sentence it showed as if the user had typed it, so a stored
 * no-dividend sentence is the editor's, never a proposal that contradicts the
 * table on purpose.
 */
export function dispositionText(stored: string | undefined, amounts: DispositionTextAmounts): string {
  if (stored === undefined) return defaultDispositionText(amounts)
  if (amounts.proposed_dividend > 0 && stored.trim() === NO_DIVIDEND_DISPOSITION_TEXT) {
    return defaultDispositionText(amounts)
  }
  return stored
}
