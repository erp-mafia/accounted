import { openAesGcm, sealAesGcm, sha256Key } from '@/lib/crypto/aes-gcm'

/**
 * AES-256-GCM encryption for long-lived refresh tokens stored in
 * extension_data. Key is derived from SUPABASE_SERVICE_ROLE_KEY (same
 * trust boundary as the database itself: anyone who can exfiltrate the
 * key can already read the data).
 */

function getKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  // Scope the key with a purpose string so this can't be confused with
  // oauth-codes.ts's derivation if both are ever compromised together.
  return sha256Key('cloud-backup:v1:' + secret)
}

export function encryptToken(plaintext: string): string {
  return sealAesGcm(getKey(), plaintext).toString('base64url')
}

export function decryptToken(ciphertext: string): string {
  return openAesGcm(getKey(), Buffer.from(ciphertext, 'base64url'))
}

/**
 * Short-lived signed state parameter for OAuth CSRF protection.
 *
 * The state encodes `{userId, companyId, origin, exp}` and is verified on the
 * callback. Stateless (no DB round-trip) and self-expiring. `origin` is the
 * validated app or brand origin the flow started on: the provider always
 * redirects to the canonical app host, which carries no session for someone
 * signed in on a brand domain, so the callback sends the browser back there.
 * Being sealed, it cannot be pointed anywhere else.
 */
const STATE_TTL_MS = 10 * 60 * 1000

interface StatePayload {
  u: string
  c: string
  /** Absent on states issued before the origin was recorded. */
  o?: string
  e: number
}

export function createOAuthState(
  userId: string,
  companyId: string,
  origin?: string
): string {
  const payload: StatePayload = {
    u: userId,
    c: companyId,
    o: origin,
    e: Date.now() + STATE_TTL_MS,
  }
  return encryptToken(JSON.stringify(payload))
}

export function verifyOAuthState(
  state: string
): { userId: string; companyId: string; origin: string | null } | null {
  try {
    const payload = JSON.parse(decryptToken(state)) as StatePayload
    if (Date.now() > payload.e) return null
    return { userId: payload.u, companyId: payload.c, origin: payload.o ?? null }
  } catch {
    return null
  }
}
