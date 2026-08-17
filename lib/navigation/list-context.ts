/**
 * Session-scoped list context for prev/next record navigation on detail pages.
 *
 * List pages write the full ordered id array (post filter/sort, not just the
 * visible slice) when the user navigates into a record; the detail page reads
 * it back to offer "bladdra" between records without returning to the list.
 *
 * sessionStorage on purpose: the context is a per-tab browsing session. A deep
 * link or a new tab has no context and the pager simply does not render.
 * Client-side lists sort with rules that are not expressible server-side
 * (e.g. lib/invoices/invoice-list-sort.ts uses an sv Intl.Collator with
 * display fallbacks), so the id order must be captured where it was computed.
 */

export interface ListContext {
  /** Ordered record ids exactly as the list presented them. */
  ids: string[]
}

export interface ListNeighbors {
  prevId: string | null
  nextId: string | null
  /** 1-based position of the current record, for "n av m" display. */
  index: number
  total: number
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  // Guarded twice: window is absent during SSR, and accessing sessionStorage
  // itself can throw (disabled storage / strict privacy modes).
  try {
    if (typeof window === 'undefined') return null
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Builds the per-company storage key, e.g. 'Accounted:list-context:invoices:<companyId>'. */
export function listContextKey(scope: string, companyId: string | null | undefined): string {
  return `Accounted:list-context:${scope}:${companyId ?? 'default'}`
}

export function writeListContext(
  key: string,
  context: ListContext,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify(context))
  } catch {
    // Quota exceeded or storage blocked: the pager just won't appear on the
    // detail page. Row navigation itself must never fail on this.
  }
}

export function readListContext(
  key: string,
  storage: StorageLike | null = defaultStorage(),
): ListContext | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as { ids?: unknown }
    if (!Array.isArray(candidate.ids)) return null
    if (candidate.ids.some((id) => typeof id !== 'string')) return null
    // Deliberately tolerant of extra properties (e.g. the listPath field
    // older builds wrote): only ids is consumed, and previously stored
    // contexts must keep parsing.
    return { ids: candidate.ids as string[] }
  } catch {
    // Garbage in storage (manual edits, older shapes): behave as no context.
    return null
  }
}

/**
 * Pure neighbor computation for the detail pager. Returns null when the
 * current record is not part of the context (stale context after a delete,
 * or a context written from another list).
 */
export function computeNeighbors(ids: string[], currentId: string): ListNeighbors | null {
  const position = ids.indexOf(currentId)
  if (position === -1) return null
  return {
    prevId: position > 0 ? ids[position - 1] : null,
    nextId: position < ids.length - 1 ? ids[position + 1] : null,
    index: position + 1,
    total: ids.length,
  }
}
