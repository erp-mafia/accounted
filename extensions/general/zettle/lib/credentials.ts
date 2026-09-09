import crypto from 'crypto'

/**
 * At-rest encryption for Zettle OAuth refresh tokens.
 *
 * AES-256-GCM with a dedicated env key, mirroring the Shopify/WooCommerce
 * credential stores: 12-byte IV, 16-byte auth tag, layout iv|tag|ciphertext,
 * base64url encoded. The key is deployment-wide; what makes rows useless
 * off-server is that ZETTLE_CREDENTIALS_ENCRYPTION_KEY never leaves the
 * environment.
 */

const ALGORITHM = 'aes-256-gcm'

/** Whether the integration is configured on this deployment. */
export function isZettleConfigured(): boolean {
  return Boolean(
    process.env.ZETTLE_CLIENT_ID &&
      process.env.ZETTLE_CLIENT_SECRET &&
      process.env.ZETTLE_CREDENTIALS_ENCRYPTION_KEY,
  )
}

function getEncryptionKey(): Buffer {
  const key = process.env.ZETTLE_CREDENTIALS_ENCRYPTION_KEY
  if (!key) throw new Error('ZETTLE_CREDENTIALS_ENCRYPTION_KEY is required')
  return crypto.createHash('sha256').update(key).digest()
}

export function encryptCredential(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64url')
}

export function decryptCredential(ciphertext: string): string {
  const key = getEncryptionKey()
  const combined = Buffer.from(ciphertext, 'base64url')
  const iv = combined.subarray(0, 12)
  const tag = combined.subarray(12, 28)
  const encrypted = combined.subarray(28)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

/** Decrypted refresh token for an active connection. */
export function refreshTokenOf(connection: {
  refresh_token_encrypted: string | null
}): string {
  if (!connection.refresh_token_encrypted) {
    throw new Error('Connection has no stored refresh token')
  }
  return decryptCredential(connection.refresh_token_encrypted)
}
