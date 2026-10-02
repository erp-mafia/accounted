/**
 * Webhook signature generation + verification.
 *
 * Signature header (Stripe-style):
 *   X-Gnubok-Signature: t=<unix>,v1=<hex-HMAC-SHA256>
 *
 * Where the signed payload is:
 *   `${t}.${rawBody}`
 *
 * The `t` (unix timestamp in seconds) is included in the signed payload
 * so receivers can implement replay-window checks. The receiver-side
 * verification (parse the header, recompute the HMAC, apply a 5-minute
 * tolerance) is documented in the docs cookbook (lib/docs/content/webhooks.ts);
 * receivers can pick their own tolerance.
 *
 * Why HMAC-SHA256 (not Ed25519): every Node/Python/Go/Ruby stdlib has it,
 * receivers can verify without adding a dep. Asymmetric signing buys nothing
 * for outbound webhooks where the receiver has no use for verifying the
 * signer's identity beyond "this is the secret you set on creation".
 *
 * The same `t=<unix>,v1=<hex>` over `${t}.${rawBody}` scheme is what some
 * providers sign the webhooks WE receive with (Qvalia since 2026-09), so the
 * inbound check lives here too: verifySignatureHeader().
 */

import crypto from 'crypto'

const ALGORITHM = 'sha256'

/** Industry-standard replay window for signed timestamps (Stripe, Standard Webhooks). */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300

export type SignatureVerificationFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'signature_mismatch'
  | 'timestamp_outside_tolerance'

export type SignatureVerificationResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: SignatureVerificationFailure }

/**
 * Verify a `t=<unix>,v1=<hex-HMAC-SHA256>` signature header against the RAW
 * request body bytes (never a re-serialised parse: other bytes, other MAC).
 *
 * - The timestamp is inside the HMAC input (`${t}.` + body), so it cannot be
 *   altered without breaking the signature, and a signed `t` outside
 *   `toleranceSeconds` of now (either direction) is refused: replay window.
 * - Every `v1` entry is tried, each with crypto.timingSafeEqual on the raw
 *   32-byte digests. Several entries are how a provider signs with the old
 *   and the new secret while a rotation overlaps.
 * - The signature is checked before the timestamp, so a stale-timestamp
 *   verdict is only ever given to an authentic request (useful diagnosis:
 *   clock skew or a replay, not a wrong secret).
 */
export function verifySignatureHeader(args: {
  header: string | null | undefined
  rawBody: Uint8Array | string
  secret: string
  toleranceSeconds?: number
  /** Override for tests. Defaults to current unix-seconds. */
  nowSeconds?: number
}): SignatureVerificationResult {
  if (!args.header || !args.header.trim()) return { ok: false, reason: 'missing_header' }
  if (!args.secret) return { ok: false, reason: 'signature_mismatch' }

  let timestamp: number | null = null
  const candidates: Buffer[] = []
  for (const part of args.header.split(',')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (key === 't') {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return { ok: false, reason: 'malformed_header' }
      timestamp = Number(value)
    } else if (key === 'v1' && /^[0-9a-fA-F]{64}$/.test(value)) {
      candidates.push(Buffer.from(value, 'hex'))
    }
  }
  if (timestamp === null || candidates.length === 0) return { ok: false, reason: 'malformed_header' }

  const expected = crypto
    .createHmac(ALGORITHM, args.secret)
    .update(`${timestamp}.`)
    .update(typeof args.rawBody === 'string' ? Buffer.from(args.rawBody, 'utf8') : args.rawBody)
    .digest()
  // Evaluate every candidate (no early exit) so the time taken does not say
  // which entry matched; each comparison is itself constant-time.
  let matched = false
  for (const candidate of candidates) {
    if (crypto.timingSafeEqual(candidate, expected)) matched = true
  }
  if (!matched) return { ok: false, reason: 'signature_mismatch' }

  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000)
  const tolerance = args.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: 'timestamp_outside_tolerance' }

  return { ok: true, timestamp }
}

export interface SignedHeaderParts {
  /** Unix seconds. */
  t: number
  /** Hex-encoded HMAC-SHA256(t + "." + body, secret). */
  v1: string
}

/**
 * Generate the value of the `X-Gnubok-Signature` header for an outbound
 * delivery.
 */
export function signPayload(args: {
  body: string
  secret: string
  /** Override for tests. Defaults to current unix-seconds. */
  timestamp?: number
}): { header: string; parts: SignedHeaderParts } {
  const t = args.timestamp ?? Math.floor(Date.now() / 1000)
  const v1 = crypto
    .createHmac(ALGORITHM, args.secret)
    .update(`${t}.${args.body}`)
    .digest('hex')
  return {
    header: `t=${t},v1=${v1}`,
    parts: { t, v1 },
  }
}

/**
 * Generate a fresh webhook secret. 32 bytes of crypto-random hex (256 bits
 * of entropy, 64-character output). Returned to the caller exactly once on
 * webhook creation; we do not store the plaintext anywhere except the
 * `webhooks.secret` column (used for signing on every outbound delivery).
 *
 * **Documented Security Decision (OWASP V14.2 / ISO 27001:2022 A.8.24):**
 * `webhooks.secret` is stored in plaintext rather than hashed. This is
 * unavoidable for outbound HMAC signing: the signing operation needs the
 * original byte sequence on every delivery, so a one-way hash would
 * preclude signing. Stripe, GitHub, Slack, and Twilio all follow the same
 * pattern for the same reason. Defense-in-depth comes from the database
 * (20260929173432): anon and authenticated hold no INSERT or UPDATE on
 * `webhooks` and no SELECT on `secret`, so only the service role (the v1 API
 * and the dispatcher) can set or read it; from the column-level select
 * projection on every read endpoint (the row never includes `secret`
 * outside the create and rotate responses); and from Supabase
 * encryption-at-rest. Re-evaluate if/when KMS-backed signing
 * becomes available without per-call latency cost.
 *
 * Receivers use this same value verbatim when verifying signatures.
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex')
}
