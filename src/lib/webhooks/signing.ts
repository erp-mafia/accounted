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
