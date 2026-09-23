import crypto from 'crypto'

/**
 * AES-256-GCM encryption for long-lived refresh tokens stored in
 * extension_data. Key is derived from SUPABASE_SERVICE_ROLE_KEY (same
 * trust boundary as the database itself: anyone who can exfiltrate the
 * key can already read the data).
 */

const ALGORITHM = 'aes-256-gcm'

function getKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  // Scope the key with a purpose string so this can't be confused with
  // oauth-codes.ts's derivation if both are ever compromised together.
  return crypto
    .createHash('sha256')
    .update('cloud-backup:v1:' + secret)
    .digest()
}

export function encryptToken(plaintext: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64url')
}

export function decryptToken(ciphertext: string): string {
  const key = getKey()
  const combined = Buffer.from(ciphertext, 'base64url')
  const iv = combined.subarray(0, 12)
  const tag = combined.subarray(12, 28)
  const encrypted = combined.subarray(28)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return decrypted.toString('utf8')
}

/**
 * Short-lived signed state parameter for OAuth CSRF protection.
 *
 * The state encodes `{userId, companyId, exp}` and is verified on the
 * callback. Stateless (no DB round-trip) and self-expiring.
 */
const STATE_TTL_MS = 10 * 60 * 1000

interface StatePayload {
  u: string
  c: string
  e: number
}

export function createOAuthState(userId: string, companyId: string): string {
  const payload: StatePayload = {
    u: userId,
    c: companyId,
    e: Date.now() + STATE_TTL_MS,
  }
  return encryptToken(JSON.stringify(payload))
}

export function verifyOAuthState(
  state: string
): { userId: string; companyId: string } | null {
  try {
    const payload = JSON.parse(decryptToken(state)) as StatePayload
    if (Date.now() > payload.e) return null
    return { userId: payload.u, companyId: payload.c }
  } catch {
    return null
  }
}
