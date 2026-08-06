/**
 * Meta webhook authenticity checks.
 *
 * POST: X-Hub-Signature-256 is 'sha256=' + hex(HMAC-SHA256(rawBody, app secret)),
 * computed over the RAW request body. Verify BEFORE any JSON parse: a body that
 * fails the HMAC is untrusted input and must never reach a parser.
 *
 * GET: the one-time subscription handshake sends hub.verify_token; echo
 * hub.challenge only when the token matches.
 *
 * Both compares are length-guarded timingSafeEqual (same shape as
 * lib/webhooks/signing.ts): Buffer.from(x, 'hex') silently drops invalid hex,
 * so lengths are compared AFTER decoding to keep a malformed header from
 * throwing RangeError instead of returning false.
 */

import crypto from 'crypto'

const SIGNATURE_PREFIX = 'sha256='

export function verifyMetaSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false
  const provided = header.startsWith(SIGNATURE_PREFIX)
    ? header.slice(SIGNATURE_PREFIX.length)
    : header
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  const providedBuf = Buffer.from(provided, 'hex')
  if (expectedBuf.length !== providedBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, providedBuf)
}

/** Constant-time compare of the GET handshake's hub.verify_token. */
export function verifyChallengeToken(
  token: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!token || !expected) return false
  const a = Buffer.from(token, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
