/**
 * JWT generation for Enable Banking API authentication
 *
 * Enable Banking requires JWT tokens signed with RS256 using your private key.
 * The JWT is included in the Authorization header for all API calls.
 */

import * as crypto from 'crypto'

// Prefer _PRODUCTION variants when available (Vercel production deploys)
const APP_ID = process.env.ENABLE_BANKING_APP_ID_PRODUCTION || process.env.ENABLE_BANKING_APP_ID
const PRIVATE_KEY_RAW = process.env.ENABLE_BANKING_PRIVATE_KEY_PRODUCTION || process.env.ENABLE_BANKING_PRIVATE_KEY

interface JWTHeader {
  typ: string
  alg: string
  kid: string
}

interface JWTPayload {
  iss: string
  aud: string
  iat: number
  exp: number
}

/**
 * Whether this instance can sign Enable Banking calls itself: BOTH halves of
 * an own client are present, the app id (the JWT `kid`) and the signing key.
 *
 * Callers use this to refuse at the door instead of letting generateJWT throw
 * the name of a missing environment variable at a user. Half a set is a real
 * state, not a theoretical one: setting any ONE of the four id/key variables
 * switches the bank upstream out of connector mode (see
 * lib/connect/instance/upstreams.ts), so a lone app id or a lone private key
 * leaves the instance with neither the connector nor a working own client.
 *
 * Reads the same module constants the signer uses, so it answers the only
 * question that matters: would generateJWT() succeed?
 */
export function hasSigningCredentials(): boolean {
  return Boolean(APP_ID && PRIVATE_KEY_RAW)
}

function base64UrlEncode(data: Buffer | string): string {
  const str = typeof data === 'string' ? data : data.toString('base64')
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function getPrivateKey(): string {
  if (!PRIVATE_KEY_RAW) {
    throw new Error('ENABLE_BANKING_PRIVATE_KEY environment variable is not set')
  }

  // Try decoding as base64-encoded PEM (sandbox format: base64 wrapping a PEM string)
  const decoded = Buffer.from(PRIVATE_KEY_RAW, 'base64').toString('utf-8')
  if (decoded.startsWith('-----BEGIN')) {
    return decoded
  }

  // Otherwise treat as raw base64 DER key material: wrap in PEM headers
  const lines = PRIVATE_KEY_RAW.match(/.{1,64}/g) || []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`
}

/**
 * Generate a JWT token for Enable Banking API authentication
 *
 * @param expiresInSeconds - Token validity in seconds (default: 3600 = 1 hour)
 * @returns Signed JWT token
 */
export function generateJWT(expiresInSeconds: number = 3600): string {
  if (!APP_ID) {
    throw new Error('ENABLE_BANKING_APP_ID environment variable is not set')
  }

  const now = Math.floor(Date.now() / 1000)

  const header: JWTHeader = {
    typ: 'JWT',
    alg: 'RS256',
    kid: APP_ID
  }

  const payload: JWTPayload = {
    iss: 'enablebanking.com',
    aud: 'api.enablebanking.com',
    iat: now,
    exp: now + expiresInSeconds
  }

  // Encode header and payload
  const headerBase64 = base64UrlEncode(Buffer.from(JSON.stringify(header)))
  const payloadBase64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)))

  // Create signature
  const signatureInput = `${headerBase64}.${payloadBase64}`
  const privateKey = getPrivateKey()

  const sign = crypto.createSign('RSA-SHA256')
  sign.update(signatureInput)
  sign.end()

  const signature = sign.sign(privateKey)
  const signatureBase64 = base64UrlEncode(signature)

  return `${headerBase64}.${payloadBase64}.${signatureBase64}`
}

// JWT token cache
let cachedToken: string | null = null
let cachedTokenExpiry: number = 0

/**
 * Get the Authorization header value for Enable Banking API.
 * Caches JWT tokens and reuses them until 60s before expiry.
 */
export function getAuthorizationHeader(): string {
  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && now < cachedTokenExpiry - 60) {
    return `Bearer ${cachedToken}`
  }

  const expiresInSeconds = 3600
  const token = generateJWT(expiresInSeconds)
  cachedToken = token
  cachedTokenExpiry = now + expiresInSeconds
  return `Bearer ${token}`
}

/** @internal Reset token cache: for testing only */
export function _resetTokenCache(): void {
  cachedToken = null
  cachedTokenExpiry = 0
}
