import { openAesGcm, sealAesGcm, sha256Key } from '@/lib/crypto/aes-gcm'

/**
 * At-rest encryption for Shopify custom-app client id/secret.
 *
 * AES-256-GCM (lib/crypto/aes-gcm.ts) with a dedicated env key, base64url
 * encoded. The key is deployment-wide (not
 * per-tenant); what makes rows useless off-server is that
 * SHOPIFY_CREDENTIALS_ENCRYPTION_KEY never leaves the environment.
 */

/** Whether the integration is configured on this deployment. */
export function isShopifyConfigured(): boolean {
  return Boolean(process.env.SHOPIFY_CREDENTIALS_ENCRYPTION_KEY)
}

function getEncryptionKey(): Buffer {
  const key = process.env.SHOPIFY_CREDENTIALS_ENCRYPTION_KEY
  if (!key) throw new Error('SHOPIFY_CREDENTIALS_ENCRYPTION_KEY is required')
  return sha256Key(key)
}

export function encryptCredential(plaintext: string): string {
  return sealAesGcm(getEncryptionKey(), plaintext).toString('base64url')
}

export function decryptCredential(ciphertext: string): string {
  return openAesGcm(getEncryptionKey(), Buffer.from(ciphertext, 'base64url'))
}

/** Decrypted API credentials for an active connection. */
export function credentialsOf(connection: {
  shop_domain: string
  client_id_encrypted: string | null
  client_secret_encrypted: string | null
}): { shopDomain: string; clientId: string; clientSecret: string } {
  if (!connection.client_id_encrypted || !connection.client_secret_encrypted) {
    throw new Error('Connection has no stored credentials')
  }
  return {
    shopDomain: connection.shop_domain,
    clientId: decryptCredential(connection.client_id_encrypted),
    clientSecret: decryptCredential(connection.client_secret_encrypted),
  }
}
