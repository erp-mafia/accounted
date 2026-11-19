import { openAesGcm, sealAesGcm, sha256Key } from '@/lib/crypto/aes-gcm'

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
  return sha256Key('oauth-flows:v1:' + secret)
}

export function encryptOAuthFlowValue(plaintext: string, context: string): string {
  return 'v1:' + sealAesGcm(getKey(), plaintext, context).toString('base64url')
}

export function decryptOAuthFlowValue(ciphertext: string, context: string): string {
  if (!ciphertext.startsWith('v1:')) throw new Error('Invalid OAuth flow ciphertext')
  return openAesGcm(getKey(), Buffer.from(ciphertext.slice(3), 'base64url'), context)
}
