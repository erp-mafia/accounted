import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * At-rest encryption for the secrets an oauth_flows row holds between
 * /authorize and /callback: the PKCE verifier, and during the two-minute
 * brand handoff the provider's authorization code or error text.
 *
 * Same construction as the provider OAuth handoff (PR #2305): AES-256-GCM
 * under a purpose-scoped derivation of the server-only service-role secret,
 * which every deployment already has, with the row identity as additional
 * authenticated data so a ciphertext cannot be moved between rows or
 * columns. Plaintext or unreadable values never decrypt successfully.
 */
function getKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createHash('sha256').update('oauth-flows:v1:' + secret).digest()
}

export function encryptOAuthFlowValue(plaintext: string, context: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  cipher.setAAD(Buffer.from(context))
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
}

export function decryptOAuthFlowValue(ciphertext: string, context: string): string {
  if (!ciphertext.startsWith('v1:')) throw new Error('Invalid OAuth flow ciphertext')
  const combined = Buffer.from(ciphertext.slice(3), 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', getKey(), combined.subarray(0, 12))
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(combined.subarray(12, 28))
  return Buffer.concat([decipher.update(combined.subarray(28)), decipher.final()]).toString('utf8')
}
