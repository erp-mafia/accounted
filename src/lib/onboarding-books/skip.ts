/**
 * Skipping the rest of the books act ("Hoppa över tills vidare"): what the
 * confirm says and where the user lands. Available on every step but Klart,
 * including while an import runs, so the act can never hold anyone.
 *
 * Leaving mid-import is safe because the import is not the browser's: the
 * execute route admits a durable job that the server worker finishes
 * (after() plus the per-minute cron), and Tidigare SIE-importer can follow,
 * resume or undo it. What the browser does own is the loop that starts the
 * NEXT fiscal year once one finishes. Once a skip is confirmed that loop
 * starts nothing more (BooksCtx.isLeaving), and a skip during an import
 * leaves with a full page load: the running job completes, later years are
 * not started behind the user's back (they add them from the import page,
 * where a year already imported is not sent again), and nothing keeps
 * posting imports for whichever company is active by then.
 */

import type { BooksState, BooksStep } from './reducer'

export type BooksSkipNotice = 'running' | 'resume' | 'empty' | 'later'

export interface BooksSkip {
  /** Which sentence the confirm shows. */
  notice: BooksSkipNotice
  /** Where the user lands. */
  href: string
  /** Leave with a full page load, ending the act's client-side work. */
  hardNavigation: boolean
}

/** The import page with its SIE history open: follow, resume or undo there. */
export const IMPORT_HISTORY_HREF = '/import?history=sie'

/** Steps whose work is an import. The bank and Skatteverket steps also work, but import nothing. */
const IMPORT_STEPS = new Set<BooksStep>(['sie', 'provider'])

export function booksSkip(
  state: Pick<BooksState, 'step' | 'working' | 'imported' | 'path'>,
  /** Posted entries exist, per the act's findings: the books are already here. */
  hasEntries: boolean,
): BooksSkip {
  // The resume step follows a job the server owns, running, paused or
  // failed: the history is where that job is followed, continued or undone.
  // Its notice promises no outcome, since a paused job waits for the user.
  if (state.step === 'resume') {
    return { notice: 'resume', href: IMPORT_HISTORY_HREF, hardNavigation: state.working }
  }
  if (state.working && IMPORT_STEPS.has(state.step)) {
    return { notice: 'running', href: IMPORT_HISTORY_HREF, hardNavigation: true }
  }
  const booksIn = state.imported || hasEntries || state.path === 'fresh'
  return { notice: booksIn ? 'later' : 'empty', href: '/', hardNavigation: false }
}
