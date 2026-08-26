import type { SupabaseClient } from '@supabase/supabase-js'
import {
  SESSION_TIMEOUT_COOKIE,
  type SessionAuthMethod,
  type SessionTimeoutClientState,
  type SessionTimeoutReason,
} from './session-timeout-shared'

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000
const DEFAULT_WARNING_MS = 2 * 60 * 1000
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60
const SIGNING_CONTEXT = 'accounted-session-timeout-v1:'

export interface SessionTimeoutConfig {
  enabled: boolean
  idleTimeoutMs: number
  absoluteTimeoutMs: number
  warningMs: number
  // Ignore the per-user auto_logout opt-in and enforce timeouts for every
  // cookie session (emergency lever / strict self-hosted deployments).
  enforceForAll: boolean
}

export interface SessionTimeoutState {
  version: 1
  userId: string
  sessionId: string | null
  startedAt: number
  lastActivityAt: number
  method: SessionAuthMethod
  // Snapshot of user_preferences.auto_logout taken when the state was minted.
  // Absent on cookies minted before the opt-in toggle existed: those must be
  // re-minted (reading the preference), never treated as tampered.
  autoLogout?: boolean
}

type Environment = Record<string, string | undefined>

function parseDuration(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback
  return parsed
}

export function getSessionTimeoutConfig(
  env: Environment = process.env,
): SessionTimeoutConfig {
  const defaultTimeout = env.NEXT_PUBLIC_SELF_HOSTED === 'true' ? 0 : undefined
  const idleTimeoutMs = parseDuration(
    env.NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MS,
    defaultTimeout ?? DEFAULT_IDLE_TIMEOUT_MS,
  )
  const absoluteTimeoutMs = parseDuration(
    env.NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_MS,
    defaultTimeout ?? DEFAULT_ABSOLUTE_TIMEOUT_MS,
  )
  const configuredWarningMs = parseDuration(
    env.NEXT_PUBLIC_SESSION_WARNING_MS,
    DEFAULT_WARNING_MS,
  )
  const enabledTimeouts = [idleTimeoutMs, absoluteTimeoutMs]
    .filter((timeout) => timeout > 0)
  const warningMs = enabledTimeouts.length > 0
    ? Math.min(configuredWarningMs, ...enabledTimeouts)
    : 0

  return {
    enabled: idleTimeoutMs > 0 || absoluteTimeoutMs > 0,
    idleTimeoutMs,
    absoluteTimeoutMs,
    warningMs,
    enforceForAll: env.NEXT_PUBLIC_SESSION_TIMEOUT_FORCE_ALL === 'true',
  }
}

export function createSessionTimeoutState(args: {
  userId: string
  sessionId: string | null
  method: SessionAuthMethod
  autoLogout: boolean
  now?: number
}): SessionTimeoutState {
  const now = args.now ?? Date.now()
  return {
    version: 1,
    userId: args.userId,
    sessionId: args.sessionId,
    startedAt: now,
    lastActivityAt: now,
    method: args.method,
    autoLogout: args.autoLogout,
  }
}

/**
 * Whether timeouts actually apply to this session. Auto logout is opt-in
 * per user (founder decision 2026-08-12): without the opt-in snapshot, or
 * the global force-all override, a session lives as long as the Supabase
 * refresh token.
 */
export function sessionTimeoutEnforced(
  state: SessionTimeoutState,
  config: SessionTimeoutConfig,
): boolean {
  return config.enabled && (state.autoLogout === true || config.enforceForAll)
}

/**
 * Read the user's auto_logout opt-in. A missing row is a definitive false
 * (never opted in); a FAILED read returns null, deliberately distinct from
 * the opt-out path: callers must not persist a snapshot for an unknown
 * preference (which would silently disable the control for an opted-in
 * user for the cookie's lifetime) and instead skip minting so the next
 * request retries the read. Sessions that already carry a snapshot are
 * unaffected: enforcement keeps running off the signed cookie.
 */
export async function fetchAutoLogoutPreference(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean | null> {
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('auto_logout')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) {
      console.error(
        '[session-timeout] auto_logout preference read FAILED; enforcement undetermined for this request',
        error,
      )
      return null
    }
    return data?.auto_logout === true
  } catch (error) {
    console.error(
      '[session-timeout] auto_logout preference read FAILED; enforcement undetermined for this request',
      error,
    )
    return null
  }
}

export function evaluateSessionTimeout(
  state: SessionTimeoutState,
  config: SessionTimeoutConfig,
  now = Date.now(),
): SessionTimeoutReason | null {
  if (!sessionTimeoutEnforced(state, config)) return null

  if (
    config.absoluteTimeoutMs > 0 &&
    now - state.startedAt >= config.absoluteTimeoutMs
  ) {
    return 'absolute'
  }

  if (
    config.idleTimeoutMs > 0 &&
    now - state.lastActivityAt >= config.idleTimeoutMs
  ) {
    return 'idle'
  }

  return null
}

function getSigningSecret(env: Environment): string {
  const dedicated = env.SESSION_TIMEOUT_SECRET?.trim()
  if (dedicated) return dedicated

  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (serviceRole) return serviceRole

  throw new Error(
    'Session timeout enforcement requires SESSION_TIMEOUT_SECRET or SUPABASE_SERVICE_ROLE_KEY',
  )
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

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

function encodePayload(state: SessionTimeoutState): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(state)))
}

function decodePayload(payload: string): unknown {
  const bytes = base64UrlToBytes(payload)
  if (!bytes) return null

  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

function isValidState(value: unknown): value is SessionTimeoutState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<SessionTimeoutState>

  return (
    state.version === 1 &&
    typeof state.userId === 'string' &&
    state.userId.length > 0 &&
    (state.sessionId === null || typeof state.sessionId === 'string') &&
    Number.isSafeInteger(state.startedAt) &&
    Number.isSafeInteger(state.lastActivityAt) &&
    (state.method === 'password' || state.method === 'bankid') &&
    // Absent on pre-toggle cookies: valid, but callers re-mint (see
    // sessionStateNeedsRemint) instead of treating the cookie as forged.
    (state.autoLogout === undefined || typeof state.autoLogout === 'boolean') &&
    (state.startedAt as number) > 0 &&
    (state.lastActivityAt as number) >= (state.startedAt as number)
  )
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  // The signing key is HKDF-derived with a purpose-bound info string, never
  // the raw secret: the SUPABASE_SERVICE_ROLE_KEY fallback must not use the
  // privileged credential itself as an HMAC key.
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

export async function signSessionTimeoutState(
  state: SessionTimeoutState,
  env: Environment = process.env,
): Promise<string | null> {
  // A missing signing secret must degrade the timeout feature, never crash
  // authenticated requests: verifySessionTimeoutState already returns null in
  // the same misconfiguration, so returning null here keeps both halves of
  // the feature consistently disabled.
  try {
    const payload = encodePayload(state)
    const key = await importSigningKey(getSigningSecret(env))
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${SIGNING_CONTEXT}${payload}`),
    )
    return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`
  } catch (error) {
    console.error(
      '[session-timeout] signing failed; timeout state not persisted',
      error,
    )
    return null
  }
}

export async function verifySessionTimeoutState(
  value: string | undefined,
  env: Environment = process.env,
): Promise<SessionTimeoutState | null> {
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

  const state = decodePayload(payload)
  return isValidState(state) ? state : null
}

interface SessionTimeoutCookieOptions {
  path: '/'
  httpOnly: true
  secure: boolean
  sameSite: 'lax'
  maxAge: number
}

export function sessionTimeoutCookieOptions(): SessionTimeoutCookieOptions {
  return {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  }
}

export function sessionTimeoutClearCookieOptions(): SessionTimeoutCookieOptions {
  return {
    ...sessionTimeoutCookieOptions(),
    maxAge: 0,
  }
}

export function toSessionTimeoutClientState(
  state: SessionTimeoutState,
  config: SessionTimeoutConfig,
  serverNow = Date.now(),
): SessionTimeoutClientState {
  return {
    enabled: sessionTimeoutEnforced(state, config),
    idleTimeoutMs: config.idleTimeoutMs,
    absoluteTimeoutMs: config.absoluteTimeoutMs,
    warningMs: config.warningMs,
    serverNow,
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt,
    method: state.method,
  }
}

export function sessionStateMatchesUser(
  state: SessionTimeoutState,
  userId: string,
  sessionId: string | null,
): boolean {
  if (state.userId !== userId) return false
  if (state.sessionId === null) return true
  // The state is bound to a specific Supabase session. If the current session
  // id cannot be resolved it is unknown, not a wildcard: report a mismatch so
  // the caller mints a fresh state instead of accepting another session's.
  if (sessionId === null) return false
  return state.sessionId === sessionId
}

/**
 * Pre-toggle cookies carry no auto_logout snapshot. They are authentic, so
 * they must not hit the tampering path; callers re-mint them, reading the
 * preference, so every live cookie converges on the v-with-snapshot shape.
 */
export function sessionStateNeedsRemint(state: SessionTimeoutState): boolean {
  return state.autoLogout === undefined
}

export function apiRequestSkipsSessionTimeout(
  pathname: string,
  hasAuthorizationHeader: boolean,
): boolean {
  if (
    pathname === '/api/health' ||
    pathname === '/api/log' ||
    pathname.startsWith('/api/mcp-oauth/')
  ) {
    return true
  }

  return hasAuthorizationHeader && (
    pathname.startsWith('/api/v1/') ||
    pathname.startsWith('/api/extensions/ext/mcp-server/mcp')
  )
}

export { SESSION_TIMEOUT_COOKIE }
