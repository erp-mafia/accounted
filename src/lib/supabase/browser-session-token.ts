import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'

/**
 * The browser's copy of the session's access token, held in memory only.
 *
 * The session itself is server-held: an HttpOnly cookie no script can read
 * (lib/supabase/cookie-options.ts). The browser Supabase client
 * (lib/supabase/client.ts) still talks to PostgREST, Storage and Realtime
 * directly, so it needs the short-lived access token; it gets it from
 * GET /api/auth/session-token, which runs the same auth, MFA and
 * session-timeout gates as every other API route and refreshes the session
 * server-side when it is close to expiry. The refresh token never reaches
 * the browser.
 *
 * Never persisted (no localStorage, sessionStorage or cookie): a reload asks
 * the server again. Refreshed about a minute before expiry, lazily on the
 * next use (Realtime asks on every heartbeat, so live channels stay fresh).
 * Concurrent callers share one request. A 401 means the server has no
 * session: the store empties itself and tells its listeners, so the
 * dashboard can send the user to /login instead of rendering empty lists.
 */

const TOKEN_ENDPOINT = '/api/auth/session-token'
/** Fetch a new token when the cached one has less than this left. */
const REFRESH_MARGIN_MS = 60_000
/** After a failed fetch (network, 5xx) or a token already near expiry, wait this long before asking again. */
const RETRY_AFTER_MS = 5_000

interface CachedToken {
  accessToken: string
  /** Local clock time the token expires at, from the server's expires_in (skew-free). */
  expiresAtMs: number
}

export type BrowserSessionLossReason = 'unauthenticated' | 'mfa_required'

let cached: CachedToken | null = null
let inflight: Promise<string | null> | null = null
let notBefore = 0
const tokenListeners = new Set<(token: string | null) => void>()
const lossListeners = new Set<(reason: BrowserSessionLossReason) => void>()

function setCached(next: CachedToken | null): void {
  const changed = (cached?.accessToken ?? null) !== (next?.accessToken ?? null)
  cached = next
  if (!changed) return
  for (const listener of tokenListeners) {
    try {
      listener(next?.accessToken ?? null)
    } catch {
      // A listener must never break token delivery.
    }
  }
}

function announceLoss(reason: BrowserSessionLossReason): void {
  for (const listener of lossListeners) {
    try {
      listener(reason)
    } catch {
      // Same.
    }
  }
}

/** The cached token if it still has more than `marginMs` to live. */
function tokenWithin(marginMs: number, now: number = Date.now()): string | null {
  return cached !== null && cached.expiresAtMs - now > marginMs ? cached.accessToken : null
}

interface TokenPayload {
  accessToken?: unknown
  expiresIn?: unknown
}

async function fetchToken(): Promise<string | null> {
  let response: Response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
  } catch {
    notBefore = Date.now() + RETRY_AFTER_MS
    // Offline or a blip: an unexpired token still works for PostgREST.
    return tokenWithin(0)
  }

  if (response.status === 401) {
    setCached(null)
    notBefore = Date.now() + RETRY_AFTER_MS
    // A session-timeout 401 carries a reason header: the timeout controller
    // owns that logout (with its reason on /login). Anything else is a
    // session the server no longer has.
    if (!notifySessionExpired(response)) announceLoss('unauthenticated')
    return null
  }
  if (response.status === 403) {
    // The session exists but is below the assurance level the API needs
    // (an MFA step-up is owed). No token until it is done.
    setCached(null)
    notBefore = Date.now() + RETRY_AFTER_MS
    announceLoss('mfa_required')
    return null
  }
  if (!response.ok) {
    notBefore = Date.now() + RETRY_AFTER_MS
    return tokenWithin(0)
  }

  let payload: { data?: TokenPayload } | null = null
  try {
    payload = (await response.json()) as { data?: TokenPayload }
  } catch {
    payload = null
  }
  const accessToken = payload?.data?.accessToken
  const expiresIn = payload?.data?.expiresIn
  if (typeof accessToken !== 'string' || !accessToken || typeof expiresIn !== 'number') {
    notBefore = Date.now() + RETRY_AFTER_MS
    return tokenWithin(0)
  }

  const now = Date.now()
  const next = { accessToken, expiresAtMs: now + expiresIn * 1000 }
  // The server refreshes within 90 s of expiry, so a fresh answer normally
  // has an hour left. If it does not (auth outage), do not ask again on
  // every call.
  notBefore = next.expiresAtMs - now > REFRESH_MARGIN_MS ? 0 : now + RETRY_AFTER_MS
  setCached(next)
  return accessToken
}

/**
 * The current access token, or null when there is no session (or no
 * browser). Never throws.
 */
export async function getBrowserAccessToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null

  const now = Date.now()
  const fresh = tokenWithin(REFRESH_MARGIN_MS, now)
  if (fresh) return fresh
  if (now < notBefore) return tokenWithin(0, now)

  inflight ??= fetchToken().finally(() => {
    inflight = null
  })
  return inflight
}

/** Forget the token (logout). The next use asks the server again. */
export function clearBrowserAccessToken(): void {
  notBefore = 0
  setCached(null)
}

/** Called with the new token (or null) whenever it changes. */
export function onBrowserAccessTokenChange(listener: (token: string | null) => void): () => void {
  tokenListeners.add(listener)
  return () => {
    tokenListeners.delete(listener)
  }
}

/** Called when the server says the browser no longer has a usable session. */
export function onBrowserSessionLost(listener: (reason: BrowserSessionLossReason) => void): () => void {
  lossListeners.add(listener)
  return () => {
    lossListeners.delete(listener)
  }
}

/** Test seam: reset module state between tests. */
export function resetBrowserSessionTokenForTests(): void {
  cached = null
  inflight = null
  notBefore = 0
  tokenListeners.clear()
  lossListeners.clear()
}
