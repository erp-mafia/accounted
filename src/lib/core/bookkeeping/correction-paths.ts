/**
 * Which ways of correcting a posted verifikat apply to it right now. Every
 * door that offers a correction asks here (the Rätta menu on the verifikat
 * page, the verifikat list), so none offers a path the server refuses and
 * none hides the one that keeps the verifikat.
 *
 * BFL 5 kap 5 § allows two tracks (CLAUDE.md Hard Rule 1):
 *   - inline rättelse inside the same verifikat (strike lines; change the
 *     text or the date): the correct_entry_lines_inline and
 *     correct_entry_metadata RPCs take it only while the verifikat's date is
 *     in an open, unlocked period after the company lock date. It keeps the
 *     verifikat and its number, so it comes first.
 *   - storno: Rätta rader (the storno and a corrected verifikat), Rätta datum
 *     (the storno and the same lines on another date) and Återför (the storno
 *     alone). In an open period all three book. Past a lock, a close or the
 *     company lock date only Rätta rader does: its storno and corrected
 *     verifikat are dated in the first open period after the original
 *     (assertStornoTarget with inFirstOpenPeriodWhenLocked), while Rätta
 *     datum and Återför book on the original's date and are refused. A
 *     verifikat whose date is structural (DATE_FIXED_SOURCE_TYPES) never
 *     moves, so past a lock no path applies to it.
 *
 * Nothing generic applies to a draft, a storno, or a verifikat a posted
 * storno already reverses (moved to a later period, it stays 'posted' in its
 * own locked year), nor to an opening balance: it is corrected through its
 * own flows on the verifikat page (Korrigera ingående balanser, Dela upp IB
 * per projekt), since a generic correction leaves the period pointing at the
 * stornoed IB.
 *
 * The period verdict is the period-status answer for the verifikat's date
 * (resolvePeriodStatusForDate). Unknown (not read yet, or the read failed)
 * counts as not open, as that answer itself fails closed.
 */
import { DATE_FIXED_SOURCE_TYPES } from './date-fixed-source-types'
import type { PeriodStatusValue } from './period-status'

/** Inside the same verifikat: strike lines (and add new ones), or change the text or date. */
export type InlineCorrectionPath = 'strike_lines' | 'correct_metadata'

/** A new verifikat: storno and corrected lines, storno and a new date, or the storno alone. */
export type StornoCorrectionPath = 'correct_lines' | 'correct_date' | 'reverse'

/** Entry types whose lines are never struck inline: the correct_entry_lines_inline RPC refuses them. */
export const LINE_RATTELSE_EXCLUDED_SOURCES: readonly string[] = ['storno', 'year_end', 'vat_settlement']

export interface CorrectionPathInput {
  status: string
  source_type: string
  /** A posted storno already reverses this verifikat (from its correction chain). */
  stornoed: boolean
  /** The period verdict for the verifikat's date; null while unknown. */
  periodStatus: PeriodStatusValue | null
}

export interface CorrectionPaths {
  /** Offered first: the verifikat stays, the change is logged with who and when. */
  inline: InlineCorrectionPath[]
  /** Still reachable in an open period; past a lock the only way. */
  storno: StornoCorrectionPath[]
}

const NONE: CorrectionPaths = { inline: [], storno: [] }

export function correctionPaths({ status, source_type, stornoed, periodStatus }: CorrectionPathInput): CorrectionPaths {
  if (status !== 'posted' || source_type === 'storno' || source_type === 'opening_balance' || stornoed) return NONE

  if (periodStatus === 'open') {
    const inline: InlineCorrectionPath[] = LINE_RATTELSE_EXCLUDED_SOURCES.includes(source_type)
      ? ['correct_metadata']
      : ['strike_lines', 'correct_metadata']
    return { inline, storno: ['correct_lines', 'correct_date', 'reverse'] }
  }

  // Locked, closed, behind the lock date, or not known: storno only, moved to
  // the first open period, which a structural date never is.
  return DATE_FIXED_SOURCE_TYPES.includes(source_type) ? NONE : { inline: [], storno: ['correct_lines'] }
}

/**
 * The one path a compact door (a row in the verifikat list) leads with: the
 * inline rättelse where it applies, else the ändringsverifikat; null when
 * nothing applies. Återför is never the lead: it removes the verifikat, the
 * person picks it on purpose.
 */
export function leadingCorrectionPath(paths: CorrectionPaths): InlineCorrectionPath | 'correct_lines' | null {
  return paths.inline[0] ?? (paths.storno.includes('correct_lines') ? 'correct_lines' : null)
}
