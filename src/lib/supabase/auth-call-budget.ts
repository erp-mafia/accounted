import 'server-only'
import { authForwardingFetch } from '@/lib/supabase/auth-forwarding'

/**
 * A budget on what one server instance asks Supabase Auth (GoTrue) on behalf
 * of one session, however many requests arrive.
 *
 * Why. Every request through the proxy asked GoTrue who the caller is
 * (GET /user), and every request inside the last 90 s of an access token
 * also asked for a new one (POST /token?grant_type=refresh_token). A client
 * that repeats a request, for any reason (a stuck reload, a script holding a
 * copied cookie, a page bug), therefore repeated both calls at its own pace.
 * On 2026-11-11 one session repeated GET /import nine times a second: 35,000
 * /user calls in 80 minutes, and at the refresh window 1,665 refreshes
 * answered 429 in 135 seconds, because GoTrue allows 150 refreshes per
 * 5 minutes per IP and that bucket is shared by everyone behind the IP.
 *
 * What. The fetch handed to every user-session Supabase client answers a
 * repeated question from memory instead of asking again:
 *
 * - A refresh for the same refresh token is asked once; concurrent callers
 *   share the call and callers within REFRESH_REPLAY_MS get the same answer.
 *   GoTrue itself answers a replayed refresh token with the session it
 *   already issued for its reuse interval (10 s), so within that window the
 *   replay here says what GoTrue would have said, and reuse detection past
 *   it still happens at GoTrue. A refused token (400) stays refused, and a
 *   rate-limited one (429) is not asked again until the wait GoTrue names.
 *   A 5xx is never remembered: auth-js retries it after 200 ms, and that
 *   retry has to reach GoTrue.
 * - A /user check for the same access token is asked once per USER_REPLAY_MS
 *   where the caller opts in (`replayUser`, the proxy alone). Revocation is
 *   therefore seen at most that much later on a warm instance. Route and page
 *   clients do not opt in: they read the user right after writing it. Their
 *   concurrent identical calls still share one request.
 *
 * The memory is per instance, so the bound is per instance: at most one
 * refresh per 10 s and one /user per 3 s for a session on each warm instance,
 * instead of one per request. Answers are keyed by a SHA-256 of the
 * credential presented, so only a caller holding the same token gets them.
 *
 * It also tells the caller when the auth service could not answer (429, 5xx,
 * unreachable), which is not the same as "this session is gone": see
 * AuthServiceWatch and lib/auth/auth-unavailable.ts.
 */

/** GoTrue's refresh token reuse interval: a replayed token gets the same session for this long. */
export const REFRESH_REPLAY_MS = 10_000
/** How long a /user answer stands for the next request carrying the same access token. */
export const USER_REPLAY_MS = 3_000
/** A rate-limited call is not repeated for this long, unless GoTrue names a longer wait. */
export const RATE_LIMIT_COOLDOWN_MS = 10_000
/** No named wait keeps a call away for longer than this. */
const MAX_COOLDOWN_MS = 60_000
/** Entries kept per instance; the oldest go first. */
const MAX_ENTRIES = 2_000

const AUTH_PATH_PREFIX = '/auth/v1/'

/**
 * What one request learned about the auth service. `unavailable` means its
 * latest call was rate limited, failed with a 5xx or never got through: the
 * session could not be checked, which says nothing about whether it is
 * valid. A later call that GoTrue did answer clears it: a refresh that was
 * rate limited followed by a /user check that says "no such session" is a
 * session that is gone.
 */
export interface AuthServiceWatch {
  unavailable: boolean
  /** Seconds GoTrue asked the caller to wait, when it said. */
  retryAfterSeconds: number | null
}

export function createAuthServiceWatch(): AuthServiceWatch {
  return { unavailable: false, retryAfterSeconds: null }
}

interface Snapshot {
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: string
}

interface Entry {
  pending: Promise<Snapshot> | null
  settled: Snapshot | null
  expiresAt: number
}

const answers = new Map<string, Entry>()

function isUnavailableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function retryAfterMs(snapshot: Snapshot): number | null {
  const raw = snapshot.headers.find(([name]) => name.toLowerCase() === 'retry-after')?.[1]
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

function cooldownMs(snapshot: Snapshot): number {
  return Math.min(MAX_COOLDOWN_MS, Math.max(RATE_LIMIT_COOLDOWN_MS, retryAfterMs(snapshot) ?? 0))
}

/** How long a refresh answer is replayed for the same refresh token. */
function refreshReplayMs(snapshot: Snapshot): number {
  if (snapshot.status === 429) return cooldownMs(snapshot)
  if (snapshot.status >= 500) return 0
  return REFRESH_REPLAY_MS
}

/** How long a /user answer is replayed for the same access token. */
function userReplayMs(snapshot: Snapshot): number {
  if (snapshot.status === 429) return cooldownMs(snapshot)
  if (snapshot.status >= 500) return 0
  return USER_REPLAY_MS
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Headers that describe the bytes on the wire, not the decoded text kept here. */
const WIRE_HEADERS: ReadonlySet<string> = new Set(['content-encoding', 'content-length', 'transfer-encoding'])

async function snapshotOf(response: Response): Promise<Snapshot> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()).filter(([name]) => !WIRE_HEADERS.has(name.toLowerCase())),
    body: await response.text(),
  }
}

function responseOf(snapshot: Snapshot): Response {
  // 204/304 carry no body; GoTrue never answers these two calls with them,
  // but a Response refuses a body there, so honour it.
  const bodyless = snapshot.status === 204 || snapshot.status === 304
  return new Response(bodyless ? null : snapshot.body, {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  })
}

function makeRoom(now: number): void {
  if (answers.size < MAX_ENTRIES) return
  for (const [key, entry] of answers) {
    if (!entry.pending && entry.expiresAt <= now) answers.delete(key)
  }
  for (const key of answers.keys()) {
    if (answers.size < MAX_ENTRIES) break
    answers.delete(key)
  }
}

/**
 * The answer for `key`: the remembered one while it stands, the call in
 * flight when there is one, else a new call. `replayMs` says how long the
 * new answer stands (0: only concurrent callers share it).
 */
async function budgeted(
  key: string,
  call: () => Promise<Response>,
  replayMs: (snapshot: Snapshot) => number,
): Promise<Snapshot> {
  const now = Date.now()
  const known = answers.get(key)
  if (known?.pending) return known.pending
  if (known?.settled && known.expiresAt > now) return known.settled

  makeRoom(now)
  const pending = call().then(snapshotOf)
  const entry: Entry = { pending, settled: null, expiresAt: 0 }
  answers.set(key, entry)
  try {
    const snapshot = await pending
    const standsFor = replayMs(snapshot)
    if (standsFor > 0) {
      entry.pending = null
      entry.settled = snapshot
      entry.expiresAt = Date.now() + standsFor
    } else if (answers.get(key) === entry) {
      answers.delete(key)
    }
    return snapshot
  } catch (error) {
    // Unreachable: nothing to remember, the next caller asks again.
    if (answers.get(key) === entry) answers.delete(key)
    throw error
  }
}

type BudgetedCall =
  | { kind: 'refresh'; credential: string }
  | { kind: 'user'; credential: string }

/** Which budgeted call this is, or null for everything else (passed through untouched). */
function classify(input: RequestInfo | URL, init: RequestInit | undefined): BudgetedCall | null {
  // auth-js calls fetch(url, { method, headers, body }); a Request object is not its shape.
  if (typeof input !== 'string' && !(input instanceof URL)) return null
  let url: URL
  try {
    url = new URL(typeof input === 'string' ? input : input.href)
  } catch {
    // Not a URL this module can read: not one of the two calls, the base fetch decides.
    return null
  }
  if (!url.pathname.startsWith(AUTH_PATH_PREFIX)) return null
  const method = (init?.method ?? 'GET').toUpperCase()

  if (
    method === 'POST' &&
    url.pathname === `${AUTH_PATH_PREFIX}token` &&
    url.searchParams.get('grant_type') === 'refresh_token'
  ) {
    if (typeof init?.body !== 'string') return null
    try {
      const token = (JSON.parse(init.body) as { refresh_token?: unknown }).refresh_token
      return typeof token === 'string' && token ? { kind: 'refresh', credential: token } : null
    } catch {
      // A body that is not JSON names no refresh token: sent as it is, unbudgeted.
      return null
    }
  }

  if (method === 'GET' && url.pathname === `${AUTH_PATH_PREFIX}user`) {
    const authorization = new Headers(init?.headers).get('authorization')
    return authorization ? { kind: 'user', credential: authorization } : null
  }

  return null
}

export interface AuthCallBudgetOptions {
  /** Told when the auth service could not answer one of this request's calls. */
  watch?: AuthServiceWatch
  /** Replay a /user answer for USER_REPLAY_MS (the proxy's per-request check). Off: concurrent calls only. */
  replayUser?: boolean
}

/**
 * `baseFetch` with the budget applied to the two calls a repeated request
 * repeats. Every other request goes straight through.
 */
export function budgetedAuthFetch(
  baseFetch?: typeof fetch,
  options: AuthCallBudgetOptions = {},
): typeof fetch {
  const { watch, replayUser = false } = options
  // Resolved per call, so a fetch replaced after this was built (tests) is the one used.
  const send = (input: RequestInfo | URL, init?: RequestInit) => (baseFetch ?? fetch)(input, init)

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = classify(input, init)
    if (!call) return send(input, init)

    // A replaying caller and a caller that must read fresh never share a
    // /user answer, also where the proxy and the routes run in one process.
    const kind = call.kind === 'user' && replayUser ? 'user-replay' : call.kind
    const key = `${kind}:${await sha256(call.credential)}`
    const replayMs =
      call.kind === 'refresh' ? refreshReplayMs : replayUser ? userReplayMs : () => 0
    let snapshot: Snapshot
    try {
      snapshot = await budgeted(key, () => send(input, init), replayMs)
    } catch (error) {
      if (watch) watch.unavailable = true
      throw error
    }
    if (watch) {
      watch.unavailable = isUnavailableStatus(snapshot.status)
      const wait = watch.unavailable ? retryAfterMs(snapshot) : null
      watch.retryAfterSeconds = wait === null ? null : Math.ceil(wait / 1000)
    }
    return responseOf(snapshot)
  }) as typeof fetch
}

/**
 * The fetch for a user-session Supabase client (server.ts, the proxy,
 * /auth/callback): GoTrue calls carry the end user's IP when IP address
 * forwarding is configured (lib/supabase/auth-forwarding.ts), and the two
 * repeatable ones are budgeted. The one place such a client gets its fetch.
 */
export function userSessionFetch(
  clientIp: string | null | undefined,
  options: AuthCallBudgetOptions = {},
): typeof fetch {
  return budgetedAuthFetch(authForwardingFetch(clientIp), options)
}

/** Test seam: forget every remembered answer. */
export function resetAuthCallBudgetForTests(): void {
  answers.clear()
}
