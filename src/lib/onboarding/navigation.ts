/** Tab-local drafts expire; answers stay out of URLs and browser history entries. */
export const DRAFT_TTL_MS = 2 * 60 * 60 * 1000

export interface NavigationDraft<S> {
  version: 1
  updatedAt: number
  index: number
  entries: Array<{ step: string; state: S }>
}

/** Ignore malformed, incompatible or expired storage instead of breaking onboarding. */
export function readNavigationDraft<S>(raw: string | null, now: number): NavigationDraft<S> | null {
  if (!raw) return null
  try {
    const draft = JSON.parse(raw) as NavigationDraft<S>
    if (draft.version !== 1 || !Number.isFinite(draft.updatedAt) || now - draft.updatedAt > DRAFT_TTL_MS ||
        draft.updatedAt > now || !Number.isInteger(draft.index) || !Array.isArray(draft.entries) ||
        draft.index < 0 || draft.index >= draft.entries.length || draft.entries.length > 100 ||
        !draft.entries.every((entry) => typeof entry?.step === 'string' && entry.state && typeof entry.state === 'object')) return null
    return draft
  } catch {
    return null
  }
}

/** What a flow writes into each browser entry it owns. */
export interface HistoryMarker {
  index: number
  /** How many entries directly behind this one the flow pushed itself, in draft order. */
  depth: number
}

/** The flow's marker on a history entry, or null for another page's or another flow's entry. */
export function readHistoryMarker(historyState: unknown, key: string): HistoryMarker | null {
  const marker = (historyState as { onboarding?: { key?: unknown; index?: unknown; depth?: unknown } } | null)?.onboarding
  if (!marker || marker.key !== key || !Number.isInteger(marker.index) || (marker.index as number) < 0) return null
  const index = marker.index as number
  // An entry written before depth existed vouches for nothing behind it.
  const depth = Number.isInteger(marker.depth) ? Math.min(Math.max(marker.depth as number, 0), index) : 0
  return { index, depth }
}

/**
 * Where a page load starts: a reload, or Back into an entry of an earlier page
 * load, lands on an entry that names its own question, while the stored draft
 * only knows the latest one. Without such a marker nothing behind the entry is
 * the flow's own.
 */
export function resumeDraft<S>(
  saved: NavigationDraft<S> | null,
  marker: HistoryMarker | null,
): { draft: NavigationDraft<S> | null; depth: number } {
  if (!saved || !marker || !saved.entries[marker.index]) return { draft: saved, depth: 0 }
  return { draft: { ...saved, index: marker.index }, depth: marker.depth }
}

/** The nearest earlier entry showing another step, or -1: Back must change what is on screen. */
export function previousStepIndex<S>(draft: NavigationDraft<S>): number {
  const step = draft.entries[draft.index].step
  for (let index = draft.index - 1; index >= 0; index--) {
    if (draft.entries[index].step !== step) return index
  }
  return -1
}

export type BackMove =
  | { kind: 'history'; distance: number }
  | { kind: 'restore'; index: number }
  | { kind: 'fallback' }

/**
 * How Back reaches `target` (-1 when the draft has nothing earlier): through
 * the browser only while every entry on the way is the flow's own, otherwise
 * by restoring the entry in place, because what lies behind is another page,
 * often one that sends the user straight back here.
 */
export function backMove(index: number, depth: number, target: number): BackMove {
  if (target < 0) return { kind: 'fallback' }
  const distance = index - target
  return distance <= depth ? { kind: 'history', distance } : { kind: 'restore', index: target }
}

/** A step back the flow takes on its own replaces the active entry instead of adding one after it. */
export function replaceNavigation<S>(draft: NavigationDraft<S> | null, step: string, state: S, now: number): NavigationDraft<S> {
  if (!draft) return { version: 1, updatedAt: now, index: 0, entries: [{ step, state }] }
  return { version: 1, updatedAt: now, index: draft.index, entries: [...draft.entries.slice(0, draft.index), { step, state }] }
}

/** Edit the active question in place, or append a step and discard abandoned forward history. */
export function recordNavigation<S>(
  draft: NavigationDraft<S> | null,
  step: string,
  state: S,
  now: number,
  beforeStep?: (previous: S, current: S) => S,
): NavigationDraft<S> {
  if (!draft) return { version: 1, updatedAt: now, index: 0, entries: [{ step, state }] }
  const entries = [...draft.entries]
  if (entries[draft.index].step === step) {
    entries[draft.index] = { step, state }
    return { ...draft, updatedAt: now, entries }
  }
  const previous = entries[draft.index]
  if (beforeStep) entries[draft.index] = { ...previous, state: beforeStep(previous.state, state) }
  const next = [...entries.slice(0, draft.index + 1), { step, state }].slice(-100)
  return { version: 1, updatedAt: now, index: next.length - 1, entries: next }
}
