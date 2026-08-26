import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  encryptCredential,
  decryptCredential,
  credentialsOf,
  isShopifyConfigured,
} from '../lib/credentials'

describe('shopify credentials encryption', () => {
  beforeEach(() => {
    vi.stubEnv('SHOPIFY_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('round-trips a credential', () => {
    const ciphertext = encryptCredential('shpca_client_secret_123')
    expect(ciphertext).not.toContain('shpca')
    expect(decryptCredential(ciphertext)).toBe('shpca_client_secret_123')
  })

  it('uses a fresh IV per encryption', () => {
    const a = encryptCredential('same-input')
    const b = encryptCredential('same-input')
    expect(a).not.toBe(b)
    expect(decryptCredential(a)).toBe('same-input')
    expect(decryptCredential(b)).toBe('same-input')
  })

  it('rejects tampered ciphertext', () => {
    const ciphertext = encryptCredential('secret')
    const buf = Buffer.from(ciphertext, 'base64url')
    buf[buf.length - 1] ^= 0xff
    expect(() => decryptCredential(buf.toString('base64url'))).toThrow()
  })

  it('throws without the env key', () => {
    vi.stubEnv('SHOPIFY_CREDENTIALS_ENCRYPTION_KEY', '')
    expect(isShopifyConfigured()).toBe(false)
    expect(() => encryptCredential('x')).toThrow(/SHOPIFY_CREDENTIALS_ENCRYPTION_KEY/)
  })

  it('credentialsOf decrypts a connection and refuses missing credentials', () => {
    const creds = credentialsOf({
      shop_domain: 'minbutik.myshopify.com',
      client_id_encrypted: encryptCredential('client-id'),
      client_secret_encrypted: encryptCredential('client-secret'),
    })
    expect(creds).toEqual({
      shopDomain: 'minbutik.myshopify.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    })
    expect(() =>
      credentialsOf({
        shop_domain: 'minbutik.myshopify.com',
        client_id_encrypted: null,
        client_secret_encrypted: null,
      }),
    ).toThrow(/no stored credentials/)
  })
})
