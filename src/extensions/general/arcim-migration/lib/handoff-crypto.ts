import { openAesGcm, sealAesGcm, sha256Key } from '@/lib/crypto/aes-gcm'

// Match the existing extension credential-encryption pattern with a dedicated
// key purpose. Both callback domains already require this server-only secret.
function getKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return sha256Key('arcim-migration:handoff:v1:' + secret)
}

export function encryptHandoffValue(plaintext: string, context: string): string {
  return 'v1:' + sealAesGcm(getKey(), plaintext, context).toString('base64url')
}

export function decryptHandoffValue(ciphertext: string, context: string): string {
  // Never accept an old plaintext value as a successful decryption.
  if (!ciphertext.startsWith('v1:')) throw new Error('Invalid OAuth handoff ciphertext')
  return openAesGcm(getKey(), Buffer.from(ciphertext.slice(3), 'base64url'), context)
}
