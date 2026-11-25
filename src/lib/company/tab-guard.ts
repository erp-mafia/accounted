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

/**
 * Request header the tab sets on every same-origin /api/ request: the company
 * this tab is rendering. withRouteContext refuses a write whose value differs
 * from the company it resolved for the session.
 */
export const TAB_COMPANY_HEADER = 'x-tab-company-id'

/**
 * Response header withRouteContext sets once it has resolved the session's
 * active company: the company the server acted on. The tab compares it with
 * the company it shows.
 */
export const ACTIVE_COMPANY_HEADER = 'x-active-company-id'

/** Methods that mutate state and must not run from a stale tab. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Methods that never write: the server does not check the tab's company. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The route that answers which company the session has active. */
export const COMPANY_CURRENT_PATH = '/api/company/current'

/**
 * How long the tab waits before it asks the server, after an answer named
 * another company than the tab shows. A change of company this tab started
 * itself (a new company, a removed one) renders the tab with the new company
 * within the wait, and the question is then never put.
 */
export const ACTIVE_COMPANY_VERIFY_DELAY_MS = 1200

/**
 * The header Next.js puts on every client-invoked server action POST
 * (verified against next@16.2.12: fetchServerAction in
 * dist/client/components/router-reducer/reducers/server-action-reducer.js
 * calls the bare global `fetch` with `{ 'next-action': actionId }`, so these
 * requests DO pass through the patched window.fetch).
 */
export const NEXT_ACTION_HEADER = 'next-action'

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
   * True while performCompanySwitch awaits its POST to COMPANY_SWITCH_PATH:
   * the ONE mutation that must pass from a mismatched tab, because it IS
   * both dialog exits ("switch back") and the deliberate user-driven
   * re-switch. The flag and the path together let exactly that request
   * through.
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
  /**
   * Asks the server which company is active, after its wait, and raises the
   * dialog when it still differs from the tab's (set by CompanyTabSync).
   * Called when an answer named another company than this tab shows.
   */
  verifyActiveCompany: (() => void) | null
} = {
  tabCompanyId: null,
  observedCompanyId: null,
  notifyBlocked: null,
  companySwitchInFlight: false,
  selfSwitchTargetId: null,
  verifyActiveCompany: null,
}

/**
 * The route every company switch persists through (app/api/company/switch).
 * Named here so the guard and the switch client agree on the one request
 * the guard lets through.
 */
export const COMPANY_SWITCH_PATH = '/api/company/switch'

/** Flagged by performCompanySwitch around the sanctioned switch request. */
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
 *   - /api paths: the fetch-based mutation surface. The one sanctioned
 *     exception is the company switch itself (POST COMPANY_SWITCH_PATH while
 *     companySwitchInFlight): it is both dialog exits and the deliberate
 *     re-switch from a stale tab, so blocking it would deadlock the guard's
 *     own resolution.
 *   - server-action POSTs (isServerAction: the request carries the
 *     `next-action` header; they POST to page routes through the same
 *     patched window.fetch). None is sanctioned.
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
  /** The sanctioned company switch is in flight; let its request through. */
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
  if (opts.isServerAction) return true
  if (opts.companySwitchInFlight && parsed.pathname === COMPANY_SWITCH_PATH) return false
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

/**
 * Whether a request URL is a same-origin /api/ request, the only requests the
 * tab labels with its company. Relative URLs resolve against the page origin.
 */
export function isSameOriginApiUrl(url: string, pageOrigin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url, pageOrigin)
  } catch {
    // An unparseable url is not a same-origin /api/ request: nothing to label.
    return false
  }
  return parsed.origin === pageOrigin && parsed.pathname.startsWith('/api/')
}

/**
 * The (input, init) pair to hand to fetch with the tab's company named in
 * TAB_COMPANY_HEADER. Returns the arguments untouched when the tab has no
 * company or the request is not a same-origin /api/ one. Otherwise `init`
 * gains a merged Headers object: the headers of init (a Headers, an entries
 * array or a record) or, when init sets none, those of a Request input (fetch
 * lets init.headers replace the Request's headers whole, so they are carried
 * over). A header the caller already set under the same name is kept.
 */
export function withTabCompanyHeader<I extends string | URL | Request>(
  input: I,
  init: RequestInit | undefined,
  opts: { tabCompanyId: string | null; pageOrigin: string },
): { input: I; init: RequestInit | undefined } {
  if (!opts.tabCompanyId) return { input, init }
  const target: string | URL | Request = input
  const url =
    typeof target === 'string'
      ? target
      : target instanceof URL
        ? target.toString()
        : target.url
  if (!isSameOriginApiUrl(url, opts.pageOrigin)) return { input, init }

  let headers: Headers
  try {
    const source =
      init?.headers ??
      (typeof target === 'string' || target instanceof URL ? undefined : target.headers)
    headers = new Headers(source)
  } catch {
    // Headers the platform cannot read: send the request as the caller made it.
    return { input, init }
  }
  if (!headers.has(TAB_COMPANY_HEADER)) headers.set(TAB_COMPANY_HEADER, opts.tabCompanyId)
  return { input, init: { ...init, headers } }
}

/**
 * The company id to treat as observed when a response arrives, or null when
 * the response gives no reason to block. Looks only at responses the caller
 * already established are same-origin /api/ ones. Silent while this tab's own
 * company switch is running or the tab is navigating to the company it
 * switched to: the switch itself answers with the new company.
 */
export function companyObservedFromResponse(opts: {
  responseCompanyId: string | null | undefined
  tabCompanyId: string | null
  companySwitchInFlight: boolean
  selfSwitchTargetId: string | null
}): string | null {
  if (opts.companySwitchInFlight || opts.selfSwitchTargetId) return null
  if (!opts.responseCompanyId) return null
  return isTabMismatch(opts.tabCompanyId, opts.responseCompanyId) ? opts.responseCompanyId : null
}

/**
 * Server side: whether a request must be refused because the tab that sent it
 * shows another company than the one the session has active. Only a mutating
 * request that names a company (TAB_COMPANY_HEADER) can be refused; the
 * company switch itself never is, as it is how the dialog's exits get out.
 */
export function shouldRefuseForTabCompany(opts: {
  method: string | undefined
  pathname: string
  tabCompanyHeader: string | null | undefined
  activeCompanyId: string
}): boolean {
  const method = (opts.method ?? 'GET').toUpperCase()
  if (SAFE_METHODS.has(method)) return false
  if (opts.pathname === COMPANY_SWITCH_PATH) return false
  const claimed = opts.tabCompanyHeader?.trim()
  if (!claimed) return false
  return claimed !== opts.activeCompanyId
}
