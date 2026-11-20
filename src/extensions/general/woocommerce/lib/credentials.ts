import { openAesGcm, sealAesGcm, sha256Key } from '@/lib/crypto/aes-gcm'

/**
 * At-rest encryption for WooCommerce consumer key/secret.
 *
 * AES-256-GCM (lib/crypto/aes-gcm.ts) with a dedicated env key, base64url
 * encoded. The key is
 * deployment-wide (not per-tenant); what makes rows useless off-server is
 * that WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY never leaves the environment.
 */

/** Whether the integration is configured on this deployment. */
export function isWooCommerceConfigured(): boolean {
  return Boolean(process.env.WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY)
}

function getEncryptionKey(): Buffer {
  const key = process.env.WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY
  if (!key) throw new Error('WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY is required')
  return sha256Key(key)
}

export function encryptCredential(plaintext: string): string {
  return sealAesGcm(getEncryptionKey(), plaintext).toString('base64url')
}

export function decryptCredential(ciphertext: string): string {
  return openAesGcm(getEncryptionKey(), Buffer.from(ciphertext, 'base64url'))
}
