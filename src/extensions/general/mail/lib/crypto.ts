import crypto from 'crypto'
import { openAesGcm, sealAesGcm, sha256Key } from '@/lib/crypto/aes-gcm'

/**
 * AES-256-GCM for mailbox refresh tokens.
 *
 * A mail grant is the hottest credential this product holds: it reads someone's
 * correspondence, not just their backups. So the key is its own env var by
 * preference (MAIL_TOKEN_ENCRYPTION_KEY, 32 bytes hex) and can be rotated
 * without touching the database password, following the Skatteverket
 * token-store rather than cloud-backup's service-role derivation.
 *
 * Two formats, told apart by a prefix rather than by trying keys:
 *
 *   v2.<base64url>   sealed with MAIL_TOKEN_ENCRYPTION_KEY. Read only with that
 *                    key: without it the token is unusable, never retried with
 *                    another key.
 *   <base64url>      legacy, sealed with a key derived from
 *                    SUPABASE_SERVICE_ROLE_KEY (the only format until the
 *                    dedicated key existed). Always read with the derived key,
 *                    so setting the dedicated key never strands a stored grant;
 *                    the connection re-seals it in the new format the next time
 *                    it reads it (getAccessToken).
 *
 * Without MAIL_TOKEN_ENCRYPTION_KEY everything is sealed the legacy way, so
 * local development and self-hosted deployments work before anyone sets it;
 * that is the same trust boundary as the database itself, and the purpose
 * string keeps the derivation distinct from every other one in the codebase.
 * base64url has no '.', so no legacy ciphertext can ever start with the prefix.
 */

const DEDICATED_PREFIX = 'v2.'

/** A token that cannot be read or sealed because a key is missing or malformed. */
export class MailTokenKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailTokenKeyError'
  }
}

/** The dedicated key, or null when MAIL_TOKEN_ENCRYPTION_KEY is unset. */
function dedicatedKey(): Buffer | null {
  const raw = process.env.MAIL_TOKEN_ENCRYPTION_KEY?.trim()
  if (!raw) return null
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new MailTokenKeyError(
      "MAIL_TOKEN_ENCRYPTION_KEY must be 32 bytes of hex: openssl rand -hex 32 | tr -d '\\n'",
    )
  }
  return Buffer.from(raw, 'hex')
}

function derivedKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new MailTokenKeyError('SUPABASE_SERVICE_ROLE_KEY is required for legacy mail tokens')
  return sha256Key('mail-connections:v1:' + secret)
}

function seal(key: Buffer, plaintext: string): string {
  return sealAesGcm(key, plaintext).toString('base64url')
}

function open(key: Buffer, sealed: string): string {
  return openAesGcm(key, Buffer.from(sealed, 'base64url'))
}

export function encryptToken(plaintext: string): string {
  const key = dedicatedKey()
  return key ? DEDICATED_PREFIX + seal(key, plaintext) : seal(derivedKey(), plaintext)
}

export function decryptToken(ciphertext: string): string {
  if (ciphertext.startsWith(DEDICATED_PREFIX)) {
    const key = dedicatedKey()
    // Fail closed: a token sealed with the dedicated key is never tried with
    // the derived one, which would only turn a configuration error into a
    // confusing authentication failure.
    if (!key) {
      throw new MailTokenKeyError('This mail token needs MAIL_TOKEN_ENCRYPTION_KEY, which is not set')
    }
    return open(key, ciphertext.slice(DEDICATED_PREFIX.length))
  }
  return open(derivedKey(), ciphertext)
}

/**
 * Whether a stored ciphertext is in the legacy format while the dedicated key
 * is available, so reading it is the moment to re-seal it. False when the key
 * is unset or malformed: then there is nothing better to seal it with.
 */
export function shouldReseal(ciphertext: string): boolean {
  if (ciphertext.startsWith(DEDICATED_PREFIX)) return false
  try {
    return dedicatedKey() !== null
  } catch {
    return false
  }
}

/**
 * Short-lived signed state for OAuth CSRF protection. Stateless and
 * self-expiring, so a callback needs no database round-trip to be trusted.
 */
const STATE_TTL_MS = 10 * 60 * 1000

interface StatePayload {
  u: string
  c: string
  e: number
  /** PKCE code verifier. Absent from states minted before PKCE. */
  v?: string
  /**
   * The allowlisted origin (the app or a brand domain) the consent started
   * on. Google redirects to the one registered callback on the canonical
   * host, which carries no session for someone signed in on a brand domain,
   * so the callback sends the browser back there. Sealed, so it cannot be
   * pointed anywhere else. Absent from states minted before it was recorded.
   */
  o?: string
}

export function createOAuthState(
  userId: string,
  companyId: string,
  codeVerifier?: string,
  origin?: string,
): string {
  const payload: StatePayload = {
    u: userId,
    c: companyId,
    e: Date.now() + STATE_TTL_MS,
    ...(codeVerifier ? { v: codeVerifier } : {}),
    ...(origin ? { o: origin } : {}),
  }
  return encryptToken(JSON.stringify(payload))
}

/**
 * A new consent flow: the signed state, carrying a fresh PKCE verifier
 * (RFC 7636) inside its encryption, and the S256 challenge for the
 * authorization URL. The verifier never leaves the server in the clear: the
 * browser only ever holds the encrypted state, so an intercepted code is
 * worthless without the state it was issued with.
 */
export function createOAuthFlow(
  userId: string,
  companyId: string,
  origin?: string,
): { state: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  return {
    state: createOAuthState(userId, companyId, codeVerifier, origin),
    codeChallenge: pkceS256Challenge(codeVerifier),
  }
}

/**
 * The S256 transform of RFC 7636 section 4.2:
 * BASE64URL-ENCODE(SHA256(ASCII(code_verifier))). A single SHA-256 is what
 * the standard prescribes: the verifier is 32 random bytes, not a password,
 * so a slow password hash would buy nothing and break the protocol.
 */
export function pkceS256Challenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
}

export function verifyOAuthState(
  state: string,
): { userId: string; companyId: string; codeVerifier: string | null; origin: string | null } | null {
  try {
    const payload = JSON.parse(decryptToken(state)) as StatePayload
    if (Date.now() > payload.e) return null
    return {
      userId: payload.u,
      companyId: payload.c,
      codeVerifier: payload.v ?? null,
      origin: payload.o ?? null,
    }
  } catch {
    return null
  }
}
