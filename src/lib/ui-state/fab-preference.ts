'use client'

/**
 * A person's choice to hide the floating button in the bottom right corner.
 *
 * Two buttons have held that corner, and each has its own choice: hiding the
 * built-in assistant's button (user_preferences.hide_assistant_fab) says
 * nothing about the support's, which came later and is another thing
 * (ui_state.support_fab_hidden). The button's own X and the row under
 * Inställningar > Ditt konto both write through here, so the two can never
 * store the same choice in different places.
 */
export type FabKind = 'assistant' | 'support'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** Stores the choice. The caller reads the response: a refused save is shown, not swallowed. */
export function saveFabHidden(kind: FabKind, hidden: boolean): Promise<Response> {
  if (kind === 'support') {
    return fetch('/api/user/ui-state', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ support_fab_hidden: hidden }),
    })
  }
  return fetch('/api/user/preferences', {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ hide_assistant_fab: hidden }),
  })
}

/** The stored choice, out of the `data` of GET /api/user/preferences. */
export function storedFabHidden(
  kind: FabKind,
  data: { hide_assistant_fab?: unknown; support_fab_hidden?: unknown } | null | undefined,
): boolean {
  return Boolean(kind === 'support' ? data?.support_fab_hidden : data?.hide_assistant_fab)
}
