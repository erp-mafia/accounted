import crypto from 'node:crypto'

/**
 * HMAC-signed connector state for the bank/SKV consent round-trip.
 *
 * The instance never registers a redirect URI with Enable Banking or
 * Skatteverket: the consent redirect goes to OUR hosted callback (already
 * registered), which then bounces the browser back to the instance. To do
 * that safely the proxy replaces the upstream `state` with a token that
 * carries where to return, the original instance state, and which key owns
 * the flow, all signed so a tampered token is rejected. No storage: the token
 * is self-contained and short-lived.
 *
 * Format: `ck1.<base64url(json)>.<base64url(hmac-sha256)>`.
 */

const VERSION = 'ck1'
const DEFAULT_TTL_MS = 15 * 60 * 1000

export interface ConnectorStatePayload {
  /** connector_key id that owns this flow. */
  kid: string
  /** service: 'bank' | 'skv'. */
  svc: 'bank' | 'skv'
  /** Absolute return URL on the instance (the instance's own callback). */
  ret: string
  /** The instance's original state value, echoed back untouched. */
  st: string
  /** Instance company ref, for the ledger. */
  cref: string
  /** issued-at, ms. */
  iat: number
}

function getSecret(): string {
  const explicit = process.env.CONNECTOR_STATE_SECRET?.trim()
  if (explicit) return explicit
  // Fall back to a value derived from the service-role key so a deployment
  // that forgot to set the dedicated secret still signs consistently. Never
  // the raw key: a one-way derivation so the signing secret can't be reversed
  // into the Supabase credential.
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!svc) throw new Error('CONNECTOR_STATE_SECRET (or SUPABASE_SERVICE_ROLE_KEY) is required to sign connector state')
  return crypto.createHash('sha256').update(`connector-state:${svc}`).digest('hex')
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export function signConnectorState(payload: Omit<ConnectorStatePayload, 'iat'>, now = Date.now()): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify({ ...payload, iat: now })))
  const sig = crypto.createHmac('sha256', getSecret()).update(`${VERSION}.${body}`).digest()
  return `${VERSION}.${body}.${b64urlEncode(sig)}`
}

export type VerifyStateResult =
  | { ok: true; payload: ConnectorStatePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }

export function verifyConnectorState(token: string, now = Date.now(), ttlMs = DEFAULT_TTL_MS): VerifyStateResult {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' }
  const [, body, sig] = parts
  const expected = crypto.createHmac('sha256', getSecret()).update(`${VERSION}.${body}`).digest()
  const given = b64urlDecode(sig)
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' }
  }
  let payload: ConnectorStatePayload
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8')) as ConnectorStatePayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof payload.iat !== 'number' || now - payload.iat > ttlMs || payload.iat > now + 60_000) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, payload }
}

/** True when a raw upstream `state` value is one of our signed connector states. */
export function isConnectorState(state: string | null | undefined): boolean {
  return typeof state === 'string' && state.startsWith(`${VERSION}.`)
}
