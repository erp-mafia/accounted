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
