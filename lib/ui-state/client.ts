import { mutate } from 'swr'
import type { UserUiState } from '@/types'

export const USER_UI_STATE_SWR_KEY = 'user-ui-state'

/**
 * Att göra PWA badge is off until the user stores an explicit true.
 * A missing key must not set the icon badge: that path never asks for
 * notification permission, so iOS shows nothing.
 */
export function isPwaWorklistBadgeEnabled(uiState: UserUiState | undefined | null): boolean {
  return uiState?.pwa_worklist_badge === true
}

/**
 * Same nested-bag merge as POST /api/user/ui-state: shallow top-level patch
 * plus per-key merges for nav_folds, create_mode, agent_panel, and
 * trial_expired_ack so a partial write does not wipe siblings in the SWR cache.
 */
export function mergeUiStatePatch(
  current: UserUiState | undefined | null,
  patch: Partial<UserUiState>,
): UserUiState {
  const base = current ?? {}
  return {
    ...base,
    ...patch,
    ...(patch.nav_folds
      ? { nav_folds: { ...base.nav_folds, ...patch.nav_folds } }
      : {}),
    ...(patch.create_mode
      ? { create_mode: { ...base.create_mode, ...patch.create_mode } }
      : {}),
    ...(patch.agent_panel
      ? { agent_panel: { ...base.agent_panel, ...patch.agent_panel } }
      : {}),
    ...(patch.trial_expired_ack
      ? { trial_expired_ack: { ...base.trial_expired_ack, ...patch.trial_expired_ack } }
      : {}),
  }
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
    (current: UserUiState | undefined) => mergeUiStatePatch(current, patch),
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
