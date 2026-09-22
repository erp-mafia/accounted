/**
 * Where the books act should open when the page loads (a reload, a return
 * from another tab): the act's position lives in browser memory, the
 * import's state lives in the database. This reads the latter.
 */

import type { NavigationDraft } from '@/lib/onboarding/navigation'
import type { BooksState, BooksStep } from './reducer'

export type LatestImportJob = {
  id: string
  job_state: string | null
  job_kind: string | null
}

/** Job states in which the worker still owns the import (or waits for a resume). */
const ACTIVE_STATES = new Set(['queued', 'preparing', 'running', 'reconciling', 'paused', 'finalizing'])

export type BooksResume =
  | { kind: 'active'; importId: string }
  | { kind: 'books' }
  | { kind: 'none' }

/**
 * - active: the latest import job is still running or paused: the act opens
 *   on the theatre following it.
 * - books: nothing runs but posted entries exist: the act opens on the
 *   genomlysning, not on the provider list.
 * - none: a fresh company: the act asks where the books were.
 * Only 'import' jobs count; a duplicate-repair job is not an import.
 */
export function resolveBooksResume(latest: LatestImportJob | null, postedEntries: number): BooksResume {
  if (latest && (latest.job_kind ?? 'import') === 'import' && latest.job_state && ACTIVE_STATES.has(latest.job_state)) {
    return { kind: 'active', importId: latest.id }
  }
  if (postedEntries > 0) return { kind: 'books' }
  return { kind: 'none' }
}

const PRE_IMPORT_STEPS = new Set<BooksStep>(['source', 'sie', 'provider', 'resume'])

/** Completed server imports supersede stale drafts, including their Back history. */
export function reconcileBooksDraft(
  draft: NavigationDraft<BooksState>,
  entry: { hasBooks: boolean; resumeImportId: string | null },
): NavigationDraft<BooksState> | null {
  if (!entry.hasBooks || entry.resumeImportId) return draft
  if (PRE_IMPORT_STEPS.has(draft.entries[draft.index].state.step)) return null
  return {
    ...draft,
    // Keep indexes aligned with browser history while retiring import screens.
    entries: draft.entries.map((item) => PRE_IMPORT_STEPS.has(item.state.step)
      ? { step: 'insight', state: { ...item.state, step: 'insight', imported: true, working: false } }
      : item),
  }
}
