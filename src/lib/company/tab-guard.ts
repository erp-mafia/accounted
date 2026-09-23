/**
 * Cross-tab active-company guard logic (WL-09, tab guard).
 *
 * The active company is ONE user_preferences row per user, shared by every
 * tab and session. Two tabs on two clients therefore silently write both
 * tabs' actions into the LAST switched company's books. The guard gives each
 * tab a memory of the company it is rendering (server-rendered at mount) and
 * blocks the tab as soon as another tab switches: a blocking dialog whose
 * only exits are "switch back" or "reload as the new company". Deliberately
 * NO continue-anyway: continuing would post into the wrong company's books
 * (this is not the soft-guard pattern).
 *
 * Pure logic lives here so it is unit-testable; the DOM wiring (channel,
 * storage events, fetch wrapping, the dialog) lives in
 * components/dashboard/CompanyTabSync.tsx.
 */

/** Broadcast channel name: pre-existing wire identifier, do not rename. */
export const TAB_SYNC_CHANNEL = 'gnubok-company-switch'

/**
 * localStorage key doubling as the BroadcastChannel fallback: writing it
 * fires `storage` events in every OTHER tab of the same origin. The value is
 * JSON: { companyId, at } (the timestamp makes re-switching to the same
 * company still produce a new value, so the event always fires).
 */
export const TAB_SYNC_STORAGE_KEY = 'gnubok-active-company'

/** Methods that mutate state and must not run from a stale tab. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * The header Next.js puts on every client-invoked server action POST
 * (verified against next@16.2.12: fetchServerAction in
 * dist/client/components/router-reducer/reducers/server-action-reducer.js
 * calls the bare global `fetch` with `{ 'next-action': actionId }`, so these
 * requests DO pass through the patched window.fetch).
 */
export const NEXT_ACTION_HEADER = 'next-action'

export interface TabSyncMessage {
  companyId: string | null
}

/**
 * Shared guard state: one writer (CompanyTabSync, the single dashboard-shell
 * mount) and two readers (the patched fetch and guardBrowserWrite below).
 * Module-level so browser-direct write sites can consult the tab's belief
 * without threading React context through every mutation helper.
 */
export const guardStore: {
  /** The company this tab is rendering (server-rendered at mount). */
  tabCompanyId: string | null
  /** Last observed active company from another tab's switch broadcast. */
  observedCompanyId: string | null
  /** Raises the blocking dialog when a mutation is refused. */
  notifyBlocked: (() => void) | null
  /**
   * True while performCompanySwitch awaits the sanctioned switchCompany
   * server action: the ONE server action that must pass from a mismatched
   * tab, because it IS both dialog exits ("switch back") and the deliberate
   * user-driven re-switch. Action ids are opaque per-build hashes, so the
   * sanctioned call is identified by this flag rather than by id.
   */
  companySwitchInFlight: boolean
  /**
   * Set when THIS tab initiated a switch to the given company and is
   * hard-navigating there. The switch broadcast loops back into the
   * initiating tab (BroadcastChannel delivers to every same-name channel in
   * the same context except the posting object), which would raise the
   * "switched in another tab" dialog over the tab's own navigation. While
   * set, CompanyTabSync suppresses the dialog; mutation blocking stays
   * active. Cleared on bfcache restore (pageshow persisted): a restored page
   * renders the OLD company and must get the full guard back.
   */
  selfSwitchTargetId: string | null
} = {
  tabCompanyId: null,
  observedCompanyId: null,
  notifyBlocked: null,
  companySwitchInFlight: false,
  selfSwitchTargetId: null,
}

/** Flagged by performCompanySwitch around the sanctioned switch action. */
export function markCompanySwitchInFlight(inFlight: boolean): void {
  guardStore.companySwitchInFlight = inFlight
}

/**
 * Flagged by performCompanySwitch after the switch persisted, right before
 * it broadcasts and hard-navigates: this tab's own switch, not a foreign one.
 */
export function markSelfSwitchTarget(companyId: string | null): void {
  guardStore.selfSwitchTargetId = companyId
}

/**
 * Whether a fetch call carries the server-action marker header. Pure over the
 * (input, init) pair so it is unit-testable; Headers, record and entries
 * shapes all occur (Next uses a plain record, but the seam is generic).
 */
export function requestHasNextActionHeader(
  input: { headers?: unknown } | string | URL,
  init?: { headers?: unknown },
): boolean {
  const hasHeader = (headers: unknown): boolean => {
    if (!headers) return false
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      return headers.has(NEXT_ACTION_HEADER)
    }
    if (Array.isArray(headers)) {
      return headers.some(
        (entry) =>
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          entry[0].toLowerCase() === NEXT_ACTION_HEADER,
      )
    }
    if (typeof headers === 'object') {
      return Object.keys(headers as Record<string, unknown>).some(
        (key) => key.toLowerCase() === NEXT_ACTION_HEADER,
      )
    }
    return false
  }
  if (init && hasHeader(init.headers)) return true
  if (typeof input === 'object' && input !== null && !(input instanceof URL)) {
    return hasHeader((input as { headers?: unknown }).headers)
  }
  return false
}

/** Serialize the storage payload written on every switch. */
export function encodeStorageValue(companyId: string | null): string {
  return JSON.stringify({ companyId, at: Date.now() })
}

/** Parse a storage payload; malformed input reads as "unknown" (null). */
export function decodeStorageValue(raw: string | null): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { companyId?: unknown }
    return typeof parsed.companyId === 'string' ? parsed.companyId : null
  } catch {
    return null
  }
}

/**
 * Whether an observed active-company id conflicts with the company this tab
 * is rendering. Unknown observations (null) are never a mismatch: the guard
 * only blocks on positive evidence of a switch.
 */
export function isTabMismatch(
  tabCompanyId: string | null,
  observedCompanyId: string | null | undefined,
): boolean {
  if (!tabCompanyId) return false
  if (observedCompanyId === null || observedCompanyId === undefined) return false
  return observedCompanyId !== tabCompanyId
}

/**
 * Name of the company another tab switched to, for the guard dialog. Looks
 * through the memberships the shell already handed the client (the switcher
 * list and the foreign-host signpost list), so no request is needed at the
 * moment the tab is being told to stop. Null when the id is not among them
 * (a company this login cannot see on this host): the dialog then falls back
 * to its unnamed wording rather than guessing.
 */
export function resolveObservedCompanyName(
  observedCompanyId: string | null | undefined,
  companies: readonly { company: { id: string; name: string } }[],
  foreignCompanies: readonly { id: string; name: string }[] = [],
): string | null {
  if (!observedCompanyId) return null
  const local = companies.find((entry) => entry.company.id === observedCompanyId)
  if (local?.company.name) return local.company.name
  const foreign = foreignCompanies.find((entry) => entry.id === observedCompanyId)
  return foreign?.name || null
}

/**
 * Whether a fetch about to leave this tab must be blocked. Guards mutating
 * same-origin requests on two shapes:
 *
 *   - /api paths: the fetch-based mutation surface.
 *   - server-action POSTs (isServerAction: the request carries the
 *     `next-action` header; they POST to page routes through the same
 *     patched window.fetch). The one sanctioned exception is the company
 *     switch itself (companySwitchInFlight): it is both dialog exits and the
 *     deliberate re-switch from a stale tab, so blocking it would deadlock
 *     the guard's own resolution.
 *
 * Browser-direct Supabase calls go to another origin and are outside this
 * seam; their write sites call guardBrowserWrite() instead.
 */
export function shouldBlockMutation(opts: {
  method: string | undefined
  url: string
  pageOrigin: string
  tabCompanyId: string | null
  observedCompanyId: string | null | undefined
  /** The request carries the next-action header (a server action POST). */
  isServerAction?: boolean
  /** The sanctioned company-switch action is in flight; let it through. */
  companySwitchInFlight?: boolean
}): boolean {
  const method = (opts.method ?? 'GET').toUpperCase()
  if (!MUTATING_METHODS.has(method)) return false
  if (!isTabMismatch(opts.tabCompanyId, opts.observedCompanyId)) return false

  let parsed: URL
  try {
    parsed = new URL(opts.url, opts.pageOrigin)
  } catch {
    return false
  }
  if (parsed.origin !== opts.pageOrigin) return false
  if (opts.isServerAction) return !opts.companySwitchInFlight
  return parsed.pathname === '/api' || parsed.pathname.startsWith('/api/')
}

/**
 * Guard for browser-direct Supabase mutations (they go straight to the
 * Supabase origin, so the patched window.fetch's /api check never sees them).
 * Call before executing the write: returns true when the write may proceed.
 * On positive evidence of a cross-tab switch it raises the blocking dialog
 * (the same only-exits-are-switch-or-reload dialog, WL-09) and returns false;
 * the caller simply returns without writing.
 */
export function guardBrowserWrite(): boolean {
  if (!isTabMismatch(guardStore.tabCompanyId, guardStore.observedCompanyId)) {
    return true
  }
  guardStore.notifyBlocked?.()
  return false
}
