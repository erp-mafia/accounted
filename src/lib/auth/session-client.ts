import { clearBrowserAccessToken } from '@/lib/supabase/browser-session-token'
import { clearBrowserStorage } from '@/lib/auth/clear-browser-storage'
import { resetAnalyticsIdentity } from '@/lib/analytics/reset'
import { scrubAuthCookies } from '@/lib/auth/browser-session-cookies'

/**
 * Browser side of the server-held session.
 *
 * The session cookie is HttpOnly (CASA 2.3.1/2.3.2), so the browser can no
 * longer sign in, verify codes, step up MFA or sign out through supabase-js:
 * each of those writes the session cookie. These helpers call the
 * /api/auth/* routes that do it on the server, and return errors shaped
 * like the supabase-js ones the pages already handle ({ code, message,
 * status }: classifyAuthError and getErrorMessage read exactly those).
 */

export interface AuthClientError {
  /** GoTrue's error code where there is one (invalid_credentials, insufficient_aal, ...). */
  code?: string
  /** Swedish message from the server (already localised). */
  message: string
  message_en?: string
  status: number
}

interface CallResult<T> {
  data: T | null
  error: AuthClientError | null
}

const NETWORK_ERROR: AuthClientError = {
  code: 'network_error',
  message: 'Kunde inte nå servern. Kontrollera anslutningen och försök igen.',
  message_en: 'Could not reach the server. Check your connection and try again.',
  status: 0,
}

function toClientError(status: number, body: unknown): AuthClientError {
  const envelope = (body as { error?: unknown } | null)?.error
  if (envelope && typeof envelope === 'object') {
    const { code, message, message_en } = envelope as Record<string, unknown>
    return {
      ...(typeof code === 'string' ? { code } : {}),
      message: typeof message === 'string' && message ? message : 'Något gick fel.',
      ...(typeof message_en === 'string' ? { message_en } : {}),
      status,
    }
  }
  // Rate limiter and legacy routes answer { error: 'Swedish sentence' }.
  return {
    message: typeof envelope === 'string' && envelope ? envelope : 'Något gick fel.',
    status,
  }
}

async function call<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<CallResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      method: init.method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers:
        init.method === 'POST'
          ? { 'Content-Type': 'application/json', accept: 'application/json' }
          : { accept: 'application/json' },
      ...(init.method === 'POST' ? { body: JSON.stringify(init.body ?? {}) } : {}),
    })
  } catch {
    return { data: null, error: NETWORK_ERROR }
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) return { data: null, error: toClientError(response.status, body) }
  return { data: ((body as { data?: T } | null)?.data ?? null) as T | null, error: null }
}

// ---------------------------------------------------------------------------
// Sign-in

export async function signInWithPassword(input: {
  email: string
  password: string
  captchaToken?: string | null
}): Promise<{ error: AuthClientError | null; mfaRequired: boolean }> {
  const { data, error } = await call<{ mfaRequired: boolean }>('/api/auth/login', {
    method: 'POST',
    body: input,
  })
  return { error, mfaRequired: data?.mfaRequired === true }
}

export type OtpInput =
  | { type: 'magiclink' | 'recovery'; token_hash: string }
  | { type: 'recovery'; email: string; token: string }

export async function verifyOtp(
  input: OtpInput,
): Promise<{ error: AuthClientError | null; mfaRequired: boolean }> {
  const { data, error } = await call<{ mfaRequired: boolean }>('/api/auth/otp', {
    method: 'POST',
    body: input,
  })
  return { error, mfaRequired: data?.mfaRequired === true }
}

/** Start an OAuth sign-in; navigate to the returned provider URL. */
export async function startOAuthSignIn(
  provider: string,
  next?: string,
): Promise<{ url: string | null; error: AuthClientError | null }> {
  const { data, error } = await call<{ url: string }>('/api/auth/oauth', {
    method: 'POST',
    body: { provider, ...(next && next !== '/' ? { next } : {}) },
  })
  return { url: data?.url ?? null, error }
}

/** Start the configured SAML sign-in; navigate to the returned URL. */
export async function startSsoSignIn(
  next: string,
): Promise<{ url: string | null; error: AuthClientError | null }> {
  const { data, error } = await call<{ url: string }>('/api/auth/sso', {
    method: 'POST',
    body: { next },
  })
  return { url: data?.url ?? null, error }
}

export async function signInAnonymously(
  captchaToken?: string | null,
): Promise<{ error: AuthClientError | null }> {
  const { error } = await call('/api/auth/anonymous', {
    method: 'POST',
    body: captchaToken ? { captchaToken } : {},
  })
  return { error }
}

// ---------------------------------------------------------------------------
// The signed-in user

export interface AssuranceLevels {
  currentLevel: string | null
  nextLevel: string | null
}

export interface SessionUser {
  id: string
  email: string | null
  new_email: string | null
  is_anonymous: boolean
  /** Only has_password, bankid_linked and mfa_exempt_until. */
  app_metadata: Record<string, unknown>
  aal: AssuranceLevels
}

/** The signed-in user, or null without a session (or when unreachable). */
export async function fetchSessionUser(): Promise<SessionUser | null> {
  const { data } = await call<SessionUser>('/api/auth/me', { method: 'GET' })
  return data
}

// ---------------------------------------------------------------------------
// MFA

export interface MfaFactor {
  id: string
  factor_type: string
  status: string
  friendly_name: string | null
}

export interface MfaStatus extends AssuranceLevels {
  factors: MfaFactor[]
}

export async function fetchMfaStatus(): Promise<MfaStatus | null> {
  const { data } = await call<MfaStatus>('/api/auth/mfa', { method: 'GET' })
  return data
}

/** The verified TOTP factor, if the user has one. */
export function verifiedTotpFactor(status: MfaStatus | null): MfaFactor | null {
  return status?.factors.find((factor) => factor.factor_type === 'totp' && factor.status === 'verified') ?? null
}

export async function enrollTotp(
  friendlyName?: string,
): Promise<CallResult<{ id: string; qrCode: string; secret: string }>> {
  return call('/api/auth/mfa/enroll', {
    method: 'POST',
    body: friendlyName ? { friendlyName } : {},
  })
}

/** Challenge + verify in one step; on success the session is AAL2. */
export async function verifyTotp(
  factorId: string,
  code: string,
): Promise<{ error: AuthClientError | null }> {
  const { error } = await call('/api/auth/mfa/verify', {
    method: 'POST',
    body: { factorId, code },
  })
  return { error }
}

/** Verified security-key (WebAuthn) factors, crm#1448. */
export function verifiedWebauthnFactors(status: MfaStatus | null): MfaFactor[] {
  return status?.factors.filter((factor) => factor.factor_type === 'webauthn' && factor.status === 'verified') ?? []
}

export interface WebauthnCeremony {
  factorId: string
  challengeId: string
  publicKey: Record<string, unknown>
}

/** Start a security-key enrolment: a new factor plus its creation options. */
export async function enrollWebauthn(friendlyName?: string): Promise<CallResult<WebauthnCeremony>> {
  return call('/api/auth/mfa/webauthn/enroll', {
    method: 'POST',
    body: friendlyName ? { friendlyName } : {},
  })
}

/** Request options for signing in with a verified security key. */
export async function challengeWebauthn(
  factorId: string,
): Promise<CallResult<{ challengeId: string; publicKey: Record<string, unknown> }>> {
  return call('/api/auth/mfa/webauthn/challenge', { method: 'POST', body: { factorId } })
}

/** Finish a ceremony; on success the session is AAL2. */
export async function verifyWebauthn(input: {
  factorId: string
  challengeId: string
  type: 'create' | 'request'
  credential: Record<string, unknown>
}): Promise<{ error: AuthClientError | null }> {
  const { error } = await call('/api/auth/mfa/webauthn/verify', { method: 'POST', body: input })
  return { error }
}

export async function unenrollFactor(factorId: string): Promise<{ error: AuthClientError | null }> {
  const { error } = await call('/api/auth/mfa/unenroll', {
    method: 'POST',
    body: { factorId },
  })
  return { error }
}

/** GoTrue refused because the session is below AAL2 (step up via /mfa/verify). */
export function isInsufficientAal(error: AuthClientError | null): boolean {
  if (!error) return false
  return error.code === 'insufficient_aal' || /aal2/i.test(error.message) || /aal2/i.test(error.message_en ?? '')
}

// ---------------------------------------------------------------------------
// Sign-out

/**
 * Drop everything the browser holds for the session (CASA 6.6.1): the
 * in-memory access token, sessionStorage, localStorage minus display
 * preferences (lib/auth/clear-browser-storage.ts), the analytics identity,
 * and any script-visible leftover auth cookie from before the session became
 * server-held (a stray duplicate under another Path or Domain, PH 99).
 */
export function clearBrowserSessionState(): void {
  clearBrowserAccessToken()
  clearBrowserStorage()
  resetAnalyticsIdentity()
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      scrubAuthCookies(document, window.location)
    } catch {
      // Cookie access can be blocked; the server already removed the session.
    }
  }
}

/**
 * Sign out: the server revokes the session and deletes the HttpOnly cookie,
 * then the browser's own copies go. `scope: 'local'` (the default) ends this
 * browser's session; 'global' ends every session of the user, on every
 * device (Säkerhet's "Logga ut från alla enheter"). A sign-out on the phone
 * used to end the laptop's session too: supabase-js signOut() defaults to
 * global, and every button took that default (founder decision 2026-11-13).
 * Returns an error only when the server could not be asked at all; a 401
 * means the session was already gone, which is the goal. `revoked` is the
 * server's word that the auth server ended the session(s): false when it
 * refused (the cookies here are gone all the same), null when unknown.
 */
export async function signOut(
  options: { scope?: 'global' | 'local' } = {},
): Promise<{ error: AuthClientError | null; revoked: boolean | null }> {
  const { data, error } = await call<{ revoked?: boolean }>('/api/auth/logout', {
    method: 'POST',
    body: { scope: options.scope ?? 'local' },
  })
  clearBrowserSessionState()
  const gone = !error || error.status === 401
  // Every other tab of this origin shared the session cookie, so it is
  // signed out too: tell them, so they drop their own token and per-tab
  // storage now instead of whenever they next ask the server.
  if (gone) announceSignedOut()
  const revoked = typeof data?.revoked === 'boolean' ? data.revoked : null
  return { error: gone ? null : error, revoked }
}

const SIGNED_OUT_CHANNEL = 'gnubok-signed-out'

/**
 * Identifies this tab on the channel: BroadcastChannel delivers to every
 * other channel object of the origin, including ones in the SAME tab, and
 * the signing-out tab must not be redirected by its own announcement (it is
 * already on its way to its own destination, e.g. /register from the
 * sandbox). Not a secret; Math.random is enough (crypto.randomUUID is
 * missing outside secure contexts, i.e. a plain-http self-hosted install).
 */
const TAB_ID = Math.random().toString(36).slice(2)

function announceSignedOut(): void {
  if (typeof BroadcastChannel === 'undefined') return
  try {
    const channel = new BroadcastChannel(SIGNED_OUT_CHANNEL)
    channel.postMessage({ type: 'signed-out', from: TAB_ID })
    channel.close()
  } catch {
    // Best effort: other tabs still find out on their next server call.
  }
}

/**
 * Called when ANOTHER tab of this origin signed out. Returns an unsubscribe
 * function.
 */
export function onSignedOutElsewhere(listener: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(SIGNED_OUT_CHANNEL)
  channel.onmessage = (event: MessageEvent<{ type?: string; from?: string }>) => {
    if (event.data?.type === 'signed-out' && event.data.from !== TAB_ID) listener()
  }
  return () => channel.close()
}

/**
 * Leave with a full page load rather than a client-side navigation, so
 * nothing rendered for the previous session (client caches, component
 * state) survives in memory.
 */
export function reloadTo(destination: string): void {
  window.location.assign(destination)
}

/** Sign out, then reloadTo(destination). */
export async function signOutAndNavigate(
  destination: string,
  options: { scope?: 'global' | 'local' } = {},
): Promise<{ error: AuthClientError | null; revoked: boolean | null }> {
  const result = await signOut(options)
  reloadTo(destination)
  return result
}
