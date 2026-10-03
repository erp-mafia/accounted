/**
 * What a sign-out leaves in the browser (CASA 6.6.1, "browser storage is
 * securely cleared during logout").
 *
 * sessionStorage is emptied outright: everything in it is per-tab work in
 * progress (support and instruction drafts, onboarding and migration
 * steps, the agent panel session, list navigation, reload guards).
 *
 * localStorage is emptied except for the display preferences below, which
 * say nothing about the user, a company or the books and would only make the
 * next sign-in look different if they were dropped. Everything else goes,
 * notably every key that carries a company id (fiscal-year and filter
 * choices, sort orders, recent reports, "since last visit" and archive
 * timestamps, dismissed notices per company) and the one that carries
 * figures (the NE declaration's manual overrides).
 *
 * The session cookie itself is HttpOnly and is removed by the server
 * (POST /api/auth/logout); the in-memory access token and the analytics
 * identity are dropped by the sign-out helper (lib/auth/session-client.ts).
 */
export const PRESERVED_LOCAL_STORAGE_KEYS: readonly string[] = [
  // next-themes: light / dark / system.
  'theme',
  // Colour palette (lib/theme/palettes.ts).
  'accounted-palette',
  // Assistant chat sidebar collapsed or not (components/agent/ChatSidebar).
  'Accounted:chat-sidebar-collapsed',
  // Where "open in Claude" links go on this device: web or desktop
  // (components/skills/claude-target.ts).
  'accounted_claude_open_in',
  // Until when the global maintenance notice is dismissed on this device
  // (components/dashboard/system-notice.ts); a timestamp, not user data.
  'Accounted:system-notice-dismissed',
]

type StorageLike = Pick<Storage, 'length' | 'key' | 'removeItem' | 'clear'>

function localStorageKeys(storage: StorageLike): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null) keys.push(key)
  }
  return keys
}

/**
 * Clear browser storage for a sign-out. Returns the localStorage keys that
 * were removed (never their values). Storage that throws (private mode,
 * blocked storage) is skipped: a sign-out must never fail on it.
 */
export function clearBrowserStorage(
  stores: { local?: StorageLike | null; session?: StorageLike | null } = defaultStores(),
): string[] {
  const removed: string[] = []

  try {
    stores.session?.clear()
  } catch {
    // Nothing to clear, or not ours to clear.
  }

  const local = stores.local
  if (!local) return removed
  try {
    const preserved = new Set(PRESERVED_LOCAL_STORAGE_KEYS)
    // Collect first, then remove: removeItem re-indexes the store.
    for (const key of localStorageKeys(local)) {
      if (preserved.has(key)) continue
      try {
        local.removeItem(key)
        removed.push(key)
      } catch {
        // Keep going with the rest.
      }
    }
  } catch {
    // Same as above.
  }
  return removed
}

function defaultStores(): { local: StorageLike | null; session: StorageLike | null } {
  if (typeof window === 'undefined') return { local: null, session: null }
  let local: StorageLike | null = null
  let session: StorageLike | null = null
  try {
    local = window.localStorage
  } catch {
    local = null
  }
  try {
    session = window.sessionStorage
  } catch {
    session = null
  }
  return { local, session }
}
