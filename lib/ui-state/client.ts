import { mutate } from 'swr'
import type { UserUiState } from '@/types'

export const USER_UI_STATE_SWR_KEY = 'user-ui-state'

/**
 * Att göra PWA badge is on unless the user stored an explicit false.
 */
export function isPwaWorklistBadgeEnabled(uiState: UserUiState | undefined | null): boolean {
  return uiState?.pwa_worklist_badge !== false
}

/**
 * Fire-and-forget persistence of a partial user_preferences.ui_state patch
 * (nav collapse/folds, split-button last-used modes). Cosmetic preference
 * data: a lost write self-corrects on the next change, so failures are
 * swallowed deliberately.
 */
export function persistUiState(patch: Partial<UserUiState>): void {
  void applyUiStatePatch(patch).catch(() => {})
}

/** Same write as persistUiState, but the caller can await and handle errors. */
export function applyUiStatePatch(patch: Partial<UserUiState>): Promise<Response> {
  void mutate(
    USER_UI_STATE_SWR_KEY,
    (current: UserUiState | undefined) => ({ ...(current ?? {}), ...patch }),
    { revalidate: false },
  ).catch(() => {})
  return fetch('/api/user/ui-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/**
 * Remember the last-used mode of a split button (ui_state.create_mode),
 * keyed per surface (e.g. 'bookkeeping' -> 'mall').
 */
export function rememberCreateMode(surface: string, mode: string): void {
  persistUiState({ create_mode: { [surface]: mode } })
}

/**
 * Resolve which split-button mode to show as primary on first render:
 * the persisted last-used mode when it's still one of the valid options,
 * otherwise the given fallback. Guards against stale persisted keys after
 * an option is renamed or removed.
 */
export function resolveInitialMode<T extends string>(
  uiState: UserUiState | undefined | null,
  surface: string,
  validKeys: readonly T[],
  fallback: T,
): T {
  const persisted = uiState?.create_mode?.[surface]
  if (persisted && (validKeys as readonly string[]).includes(persisted)) {
    return persisted as T
  }
  return fallback
}
