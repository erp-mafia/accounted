/**
 * Server-held state for an in-flight BankID flow.
 *
 * Why the session id is not allowed near the browser's JavaScript
 * -------------------------------------------------------------
 * A TIC `sessionId` is an unauthenticated bearer credential. Anyone holding
 * one can POST it to /bankid/poll (skipAuth) and read the holder's
 * personnummer, or POST it to /bankid/complete with mode 'login' and receive a
 * `tokenHash` that `verifyOtp` turns into a full Supabase session, with MFA
 * skipped because BankID accounts carry `bankid_linked`. It used to be handed
 * to the client and kept in `sessionStorage`, which made every one of those a
 * single XSS away, and made the obvious fix for the cross-tab bug (move it to
 * `localStorage` so the tab BankID returns to can resume) a straight upgrade
 * of any same-origin XSS into a login-fixation primitive.
 *
 * So the id never leaves the server. It lives in an HttpOnly cookie that the
 * browser attaches to the BankID endpoints and nothing else:
 *
 *   • HttpOnly     script cannot read it, so XSS cannot steal a session.
 *   • signed       script cannot FORGE one. It does not stop a script from
 *                  planting a cookie the server genuinely minted (an attacker
 *                  can fetch one with curl), and it does not bind the flow to
 *                  a browser or a person. Planting a completed identification
 *                  is what login fixation is, so the protection against that
 *                  is not here: it is the client refusing to consume a flow
 *                  this browsing context did not start without an explicit
 *                  confirmation. See BankIdAuth's resume handling.
 *   • __Host-      forbids Domain and forces Path=/, which leaves exactly one
 *                  possible (name, domain, path) for this cookie. Without it a
 *                  script can plant the same name at a LONGER path, which the
 *                  browser sends first and the server's deletion cannot reach.
 *   • SameSite=Lax the BankID app returns the user by top-level navigation
 *                  from outside the site; Strict would drop the cookie there
 *                  and strand exactly the flow this exists to serve.
 *   • short Max-Age a BankID order is good for ~3 minutes. An abandoned flow
 *                  should not outlive it by much.
 *
 * Being a cookie rather than client storage is also what fixes the original
 * bug: cookies are shared by every tab of the origin, so whichever tab BankID
 * returns the user to, new or reloaded, simply polls and continues. No
 * client-side handoff, no cross-tab lock, no heartbeat.
 *
 * `mode` is pinned here at /start and read back at /complete, so the flow a
 * session was opened for is the only flow that can finish it. The client
 * cannot ask to complete a 'link' session as a 'login'.
 */

import { NextResponse } from 'next/server'

export type BankIdFlowMode = 'login' | 'signup' | 'link'

/**
 * HttpOnly, signed. Holds the session id, and is never readable by scripts.
 *
 * The `__Host-` prefix is load-bearing, not decoration. Browsers only refuse a
 * `document.cookie` write when it collides with an existing HttpOnly cookie on
 * the exact (name, domain, path) triple, so without the prefix a script could
 * set the SAME NAME at a longer path; RFC 6265 §5.4 serialises longer paths
 * first, so the planted one would win, and a Max-Age=0 written to the shorter
 * path could never delete it. `__Host-` forbids `Domain` and forces `Path=/`,
 * which leaves exactly one possible (name, domain, path) for this cookie: the
 * one the server owns. That also blocks cookie-tossing from a sibling
 * white-label subdomain.
 *
 * Losing the narrow Path is the price. It is worth it: the narrow Path only
 * ever bought log hygiene, whereas the shadowing it permitted was a way to
 * plant a completed session in someone else's browser.
 */
export const BANKID_FLOW_COOKIE = '__Host-accounted-bankid-flow'

/**
 * Non-secret identifier that binds one browser tab to the flow it started or
 * explicitly resumed. The signed cookie remains the credential; this header
 * only prevents a stale tab from silently acting on a newer flow that replaced
 * the shared cookie.
 */
export const BANKID_FLOW_ID_HEADER = 'x-bankid-flow-id'

/**
 * How long a fresh order may be resumed. A BankID order is good for ~3 minutes;
 * the rest covers the app switch and a slow return.
 */
export const FLOW_WINDOW_SECONDS = 300

/**
 * Replaces the window above once the identification has actually happened. The
 * signup flow then asks for an e-mail, and a user hunting for the right address
 * (or switching to a password manager and back) must not have the session
 * expire under them: on `main` this step was bounded only by TIC's own
 * retention, so a short shared budget would have been a real regression.
 */
export const FLOW_VERIFIED_WINDOW_SECONDS = 900

/** Sanity bound on a decoded expiry, so no cookie can claim an unbounded life. */
const MAX_WINDOW_MS = FLOW_VERIFIED_WINDOW_SECONDS * 1000

/**
 * Ceiling on a whole flow, measured from /start. Bounds the re-issue chain:
 * an identification cannot be kept resumable indefinitely by polling.
 */
export const MAX_TOTAL_LIFE_SECONDS = FLOW_WINDOW_SECONDS + FLOW_VERIFIED_WINDOW_SECONDS
const MAX_TOTAL_LIFE_MS = MAX_TOTAL_LIFE_SECONDS * 1000

const SIGNING_CONTEXT = 'accounted-bankid-flow-v1:'

export interface BankIdFlowState {
  version: 1
  sessionId: string
  /** Random, non-secret tab binding. The BankID session id remains HttpOnly. */
  flowId: string
  mode: BankIdFlowMode
  /**
   * Who opened a `link` flow. Linking binds a personnummer to whoever is
   * authenticated when /bankid/link runs, so without this a flow started by one
   * person and left unfinished could be picked up by the next person to use the
   * browser and bind the FIRST person's identity to the SECOND person's
   * account. Absent for login and signup, which have no user yet.
   */
  userId?: string
  /**
   * When /start opened this flow. Carried so the total life can be capped:
   * /poll extends `expiresAt` when it observes completion, and without a fixed
   * origin a caller could keep polling to push the window forward forever,
   * leaving a usable identification in the jar for as long as TIC retains it.
   */
  startedAt: number
  /** Absolute expiry, enforced server-side; the browser's Max-Age only mirrors it. */
  expiresAt: number
}

type Environment = Record<string, string | undefined>

export function isBankIdFlowMode(value: unknown): value is BankIdFlowMode {
  return value === 'login' || value === 'signup' || value === 'link'
}

/**
 * Unlike the session-timeout cookie, which degrades to unsigned-and-ignored
 * when misconfigured, this one throws: a BankID flow that cannot be bound to
 * the browser that started it must not run at all.
 */
function getSigningSecret(env: Environment): string {
  const dedicated = env.BANKID_ENCRYPTION_KEY?.trim()
  if (dedicated) return dedicated

  const sessionSecret = env.SESSION_TIMEOUT_SECRET?.trim()
  if (sessionSecret) return sessionSecret

  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (serviceRole) return serviceRole

  throw new Error(
    'BankID flow cookie requires BANKID_ENCRYPTION_KEY, SESSION_TIMEOUT_SECRET or SUPABASE_SERVICE_ROLE_KEY',
  )
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

// The explicit ArrayBuffer parameter matters: a bare Uint8Array is
// Uint8Array<ArrayBufferLike>, which crypto.subtle rejects as a BufferSource
// because it could be backed by a SharedArrayBuffer. Same annotation as
// lib/auth/session-timeout.ts, for the same reason.
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  // HKDF-derived with a purpose-bound info string, never the raw secret: the
  // same key material also encrypts personnummer at rest (lib/auth/bankid.ts)
  // and the SUPABASE_SERVICE_ROLE_KEY fallback is a privileged credential.
  // Neither may double as an HMAC key directly.
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(SIGNING_CONTEXT),
    },
    baseKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  )
}

export async function signBankIdFlow(
  state: BankIdFlowState,
  env: Environment = process.env,
): Promise<string> {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(state)))
  const key = await importSigningKey(getSigningSecret(env))
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${SIGNING_CONTEXT}${payload}`),
  )
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`
}

/**
 * Verify and decode a flow cookie. Returns null for anything that is not a
 * cookie this server minted and still considers live: bad signature, wrong
 * shape, unknown mode, an unowned `link` flow, a `startedAt` in the future,
 * one whose `expiresAt` is past or claims more than MAX_WINDOW, or a whole
 * flow older than MAX_TOTAL_LIFE. Expiry is re-checked here rather than
 * trusted to the browser's Max-Age, which a client controls.
 */
export async function verifyBankIdFlow(
  value: string | undefined,
  env: Environment = process.env,
  now: number = Date.now(),
): Promise<BankIdFlowState | null> {
  if (!value) return null
  const [payload, signature, extra] = value.split('.')
  if (!payload || !signature || extra !== undefined) return null

  const signatureBytes = base64UrlToBytes(signature)
  if (!signatureBytes) return null

  try {
    const key = await importSigningKey(getSigningSecret(env))
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      new TextEncoder().encode(`${SIGNING_CONTEXT}${payload}`),
    )
    if (!valid) return null
  } catch {
    return null
  }

  const decoded = base64UrlToBytes(payload)
  if (!decoded) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded))
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const state = parsed as Partial<BankIdFlowState>
  if (state.version !== 1) return null
  if (typeof state.sessionId !== 'string' || !state.sessionId) return null
  if (typeof state.flowId !== 'string' || !state.flowId) return null
  if (!isBankIdFlowMode(state.mode)) return null
  if (state.userId !== undefined && (typeof state.userId !== 'string' || !state.userId)) return null
  // A `link` flow with no owner cannot be validated against the caller, and an
  // unowned link is exactly the shape that binds the wrong identity.
  if (state.mode === 'link' && !state.userId) return null
  if (typeof state.startedAt !== 'number' || !Number.isFinite(state.startedAt)) return null
  if (state.startedAt > now) return null
  if (typeof state.expiresAt !== 'number' || !Number.isFinite(state.expiresAt)) return null
  if (now > state.expiresAt) return null
  // Expiry is enforced here rather than trusted to the browser's Max-Age, which
  // a client controls. The upper bound stops any cookie claiming a longer life
  // than the longest window this server ever issues.
  if (state.expiresAt - now > MAX_WINDOW_MS) return null
  // Hard cap on the whole flow, not just this cookie. /poll re-issues with a
  // longer window when it sees a completed identification; without a cap
  // measured from the original start, polling in a loop would keep a usable
  // identification alive for as long as TIC retains the session.
  if (now - state.startedAt > MAX_TOTAL_LIFE_MS) return null

  return state as BankIdFlowState
}

/**
 * `__Host-` requires Secure, Path=/ and no Domain; a cookie missing any of them
 * is rejected outright by the browser. Secure is therefore unconditional here,
 * and that costs nothing: isBankIdEnabled() (lib/auth/bankid.ts) returns false
 * whenever NEXT_PUBLIC_SELF_HOSTED is set, so there is no plain-http BankID
 * deployment to accommodate. An earlier version made Secure conditional on
 * x-forwarded-proto for that imagined case, which only meant a proxy that omits
 * the header would silently ship this cookie unprotected on a real HTTPS site.
 */
const FLOW_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const

/** Attach a flow to the response, replacing any flow already there. */
export async function setBankIdFlowCookies(
  response: NextResponse,
  state: BankIdFlowState,
  env: Environment = process.env,
  now: number = Date.now(),
): Promise<void> {
  response.cookies.set(BANKID_FLOW_COOKIE, await signBankIdFlow(state, env), {
    ...FLOW_COOKIE_OPTIONS,
    // Mirrors the signed expiry so an abandoned flow also disappears from the
    // jar; the server-side check in verifyBankIdFlow is the real bound.
    maxAge: Math.max(1, Math.ceil((state.expiresAt - now) / 1000)),
  })
}

/** End the flow. Called on every terminal outcome. */
export function clearBankIdFlowCookies(response: NextResponse): void {
  // Same name, same path, same attributes: a deletion written to a different
  // path would leave the real cookie in place.
  response.cookies.set(BANKID_FLOW_COOKIE, '', { ...FLOW_COOKIE_OPTIONS, maxAge: 0 })
}

/**
 * Read and verify the flow attached to an incoming request.
 *
 * Fails closed when the header carries more than one cookie of this name.
 * `__Host-` should make that impossible, but the cost of being wrong about a
 * browser's prefix handling is that a planted duplicate gets used instead of
 * the real one, so ambiguity is treated as no flow rather than resolved by
 * picking a winner.
 */
export async function readBankIdFlow(
  request: Request,
  env: Environment = process.env,
): Promise<BankIdFlowState | null> {
  const header = request.headers.get('cookie')
  if (!header) return null

  const values: string[] = []
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== BANKID_FLOW_COOKIE) continue
    const raw = part.slice(separator + 1).trim()
    // A malformed percent-escape throws URIError. Treat it as an unusable
    // cookie rather than letting it become a 500 in every handler that reads
    // the flow.
    try {
      values.push(decodeURIComponent(raw))
    } catch {
      return null
    }
  }

  if (values.length !== 1) return null
  return verifyBankIdFlow(values[0], env)
}
