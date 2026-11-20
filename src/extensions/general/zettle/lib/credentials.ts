import { openAesGcm, sealAesGcm, sha256Key } from '@/lib/crypto/aes-gcm'

/**
 * At-rest encryption for Zettle OAuth refresh tokens.
 *
 * AES-256-GCM (lib/crypto/aes-gcm.ts) with a dedicated env key, base64url
 * encoded. The key is deployment-wide; what makes rows useless
 * off-server is that ZETTLE_CREDENTIALS_ENCRYPTION_KEY never leaves the
 * environment.
 */

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
  return sha256Key(key)
}

export function encryptCredential(plaintext: string): string {
  return sealAesGcm(getEncryptionKey(), plaintext).toString('base64url')
}

export function decryptCredential(ciphertext: string): string {
  return openAesGcm(getEncryptionKey(), Buffer.from(ciphertext, 'base64url'))
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
