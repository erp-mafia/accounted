import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// Match the existing extension credential-encryption pattern with a dedicated
// key purpose. Both callback domains already require this server-only secret.
function getKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createHash('sha256').update('arcim-migration:handoff:v1:' + secret).digest()
}

export function encryptHandoffValue(plaintext: string, context: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  cipher.setAAD(Buffer.from(context))
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
}

export function decryptHandoffValue(ciphertext: string, context: string): string {
  // Never accept an old plaintext value as a successful decryption.
  if (!ciphertext.startsWith('v1:')) throw new Error('Invalid OAuth handoff ciphertext')
  const combined = Buffer.from(ciphertext.slice(3), 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', getKey(), combined.subarray(0, 12))
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(combined.subarray(12, 28))
  return Buffer.concat([decipher.update(combined.subarray(28)), decipher.final()]).toString('utf8')
}
