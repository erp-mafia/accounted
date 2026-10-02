/**
 * Skipping the rest of the books act ("Hoppa över tills vidare"): what the
 * confirm says and where the user lands. Available on every step but Klart,
 * including while an import runs, so the act can never hold anyone.
 *
 * Leaving mid-import is safe because the import is not the browser's: the
 * execute route admits a durable job that the server worker finishes
 * (after() plus the per-minute cron), and Tidigare SIE-importer can follow,
 * resume or undo it. What the browser does own is the loop that starts the
 * NEXT fiscal year once one finishes, so a skip during work leaves with a
 * full page load: the running job completes, later years are not started
 * behind the user's back (they add them from the import page, where a year
 * already imported is not sent again), and nothing keeps posting imports
 * for whichever company is active by then.
 */

import type { BooksState } from './reducer'

export type BooksSkipNotice = 'running' | 'empty' | 'later'

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

export function booksSkip(
  state: Pick<BooksState, 'step' | 'working' | 'imported' | 'path'>,
  /** Posted entries exist, per the act's findings: the books are already here. */
  hasEntries: boolean,
): BooksSkip {
  // The resume step follows a job the server owns, also when it paused or
  // failed: the history is where that job is continued or undone.
  if (state.working || state.step === 'resume') {
    return { notice: 'running', href: IMPORT_HISTORY_HREF, hardNavigation: true }
  }
  const booksIn = state.imported || hasEntries || state.path === 'fresh'
  return { notice: booksIn ? 'later' : 'empty', href: '/', hardNavigation: false }
}
