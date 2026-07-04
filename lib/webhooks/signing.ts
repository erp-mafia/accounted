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
 * so receivers can implement replay-window checks. We default to a 5-minute
 * tolerance on the verify side; receivers can pick their own.
 *
 * Why HMAC-SHA256 (not Ed25519): every Node/Python/Go/Ruby stdlib has it,
 * receivers can verify without adding a dep. Asymmetric signing buys nothing
 * for outbound webhooks where the receiver has no use for verifying the
 * signer's identity beyond "this is the secret you set on creation".
 */

import crypto from 'crypto'

const ALGORITHM = 'sha256'

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
 * Parse a signature header into its components. Returns null if malformed.
 * Used by the receiver-side example in the docs cookbook (Phase 6 PR-2);
 * exported here so a single canonical implementation lives in this file.
 */
export function parseSignatureHeader(header: string): SignedHeaderParts | null {
  const parts = header.split(',').map((s) => s.trim())
  let t: number | null = null
  let v1: string | null = null
  for (const p of parts) {
    const eq = p.indexOf('=')
    if (eq === -1) continue
    const k = p.slice(0, eq)
    const v = p.slice(eq + 1)
    if (k === 't') {
      const parsed = Number.parseInt(v, 10)
      if (Number.isFinite(parsed)) t = parsed
    } else if (k === 'v1') {
      v1 = v
    }
  }
  if (t === null || !v1) return null
  return { t, v1 }
}

/**
 * Verify a signature against a raw body. Constant-time comparison.
 * Returns true if the signature is valid AND within the tolerance window.
 *
 * Use this in the cookbook examples and in the :test endpoint's loopback
 * verification.
 */
export function verifySignature(args: {
  body: string
  header: string
  secret: string
  /** Tolerance window in seconds. Defaults to 300 (5 min). */
  toleranceSeconds?: number
  /** Override for tests. Defaults to current unix-seconds. */
  now?: number
}): boolean {
  const parsed = parseSignatureHeader(args.header)
  if (!parsed) return false

  const tolerance = args.toleranceSeconds ?? 300
  const now = args.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - parsed.t) > tolerance) return false

  const expected = crypto
    .createHmac(ALGORITHM, args.secret)
    .update(`${parsed.t}.${args.body}`)
    .digest('hex')

  // timingSafeEqual requires equal-length buffers: return false (not throw)
  // for length mismatch, the common case for a forged signature.
  //
  // Compare buffer lengths AFTER decoding rather than hex-string lengths:
  // `Buffer.from(v1, 'hex')` silently drops invalid hex bytes, so a v1 that
  // is the right hex length (64 chars for SHA-256) but contains non-hex
  // characters decodes to a SHORTER buffer than `expected`. Without this
  // check the timingSafeEqual call throws RangeError instead of returning
  // false, exposing a crash path to any caller passing a malformed header.
  const expectedBuf = Buffer.from(expected, 'hex')
  const actualBuf = Buffer.from(parsed.v1, 'hex')
  if (expectedBuf.length !== actualBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, actualBuf)
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
 * pattern for the same reason. Defense-in-depth comes from the
 * service-role-only INSERT/UPDATE/DELETE on `webhooks` (no anon/auth
 * write path), the column-level select projection on every read endpoint
 * (the row never includes `secret` outside the create response), and
 * Supabase encryption-at-rest. Re-evaluate if/when KMS-backed signing
 * becomes available without per-call latency cost.
 *
 * Receivers use this same value verbatim when verifying signatures.
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex')
}
