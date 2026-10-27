import { getSigningSecret } from './session-timeout'

/**
 * Shared plumbing of the verdicts the proxy signs for the request it
 * forwards: the no-verified-factor verdict for API routes (mfa-assurance.ts)
 * and the active-company verdict for page renders (active-company-verdict.ts).
 * Each signer passes its own context string, so each gets its own derived key
 * and a value minted by one never verifies as the other.
 */

export type Environment = Record<string, string | undefined>

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** The bytes a base64url value encodes, or null when it is not base64url. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    // Not base64url: the caller reads that as an invalid verdict.
    return null
  }
}

/**
 * The HMAC key of one signer: HKDF-derived from the server-only secret with
 * the signer's own info string, never the raw secret and never the same key
 * as another signer. Throws without a secret (getSigningSecret).
 */
export async function importVerdictKey(context: string, env: Environment): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getSigningSecret(env)),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(context) },
    baseKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  )
}
