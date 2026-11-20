/**
 * The signer's link: `/signera/<token>`. The token IS the authentication on
 * the public surface, so it is a credential: 32 random bytes (base64url, 43
 * characters), sha256-hashed at rest, the clear token only in the URL and the
 * mail that carried it. The same posture as the bank consent and payment
 * signing links, kept here because the ledger kernel imports no block.
 */
import { createHash, randomBytes } from 'crypto'

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export function generateSigningToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashSigningToken(token) }
}

export function hashSigningToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isValidSigningTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token)
}

/** The signer's page. */
export function signingPath(token: string): string {
  return `/signera/${encodeURIComponent(token)}`
}

export function signingUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${signingPath(token)}`
}
