/**
 * Standard Webhooks signature verification (https://www.standardwebhooks.com/),
 * implemented with node:crypto only: the Supabase Send Email hook signs its
 * requests in this format and the endpoint must stay dependency-free.
 *
 * Scheme: the secret is base64 material, presented as "v1,whsec_<base64>"
 * (Supabase dashboard) or "whsec_<base64>". The signed content is
 * "<msg-id>.<timestamp>.<raw-body>", HMAC-SHA256 over the decoded secret,
 * base64-encoded. The webhook-signature header carries a space-separated
 * list of "<version>,<signature>" entries; only symmetric v1 entries are
 * considered.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_TOLERANCE_SECONDS = 300

export interface StandardWebhookVerificationInput {
  /** Raw secret ("v1,whsec_...", "whsec_..." or bare base64). */
  secret: string
  /** Raw request body, byte-identical to what was signed. */
  payload: string
  /** webhook-id header. */
  id: string | null
  /** webhook-timestamp header (unix seconds). */
  timestamp: string | null
  /** webhook-signature header. */
  signature: string | null
  /** Replay window in seconds; default 300. */
  toleranceSeconds?: number
  /** Test hook: current time in ms. */
  nowMs?: number
}

function decodeSecret(secret: string): Buffer {
  let s = secret.trim()
  if (s.startsWith('v1,')) s = s.slice(3)
  if (s.startsWith('whsec_')) s = s.slice(6)
  return Buffer.from(s, 'base64')
}

/**
 * True only when the signature verifies and the timestamp is within the
 * replay tolerance. Never throws: any malformed input is a failed
 * verification.
 */
export function verifyStandardWebhookSignature(
  input: StandardWebhookVerificationInput,
): boolean {
  const { secret, payload, id, timestamp, signature } = input
  if (!secret || !id || !timestamp || !signature) return false

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const nowSeconds = (input.nowMs ?? Date.now()) / 1000
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  if (Math.abs(nowSeconds - ts) > tolerance) return false

  const key = decodeSecret(secret)
  if (key.length === 0) return false

  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest()

  for (const part of signature.split(/\s+/)) {
    const commaIndex = part.indexOf(',')
    if (commaIndex === -1) continue
    const version = part.slice(0, commaIndex)
    const candidateBase64 = part.slice(commaIndex + 1)
    if (version !== 'v1' || !candidateBase64) continue
    const candidate = Buffer.from(candidateBase64, 'base64')
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return true
    }
  }
  return false
}
