import crypto from 'crypto'
import type { SkatteverketTokens } from '../types'
import {
  fetchWithTimeout,
  OAUTH_TIMEOUT_MS,
  SKATTEVERKET_EXCHANGE_TIMEOUT_MS,
} from '@/lib/http/fetch-with-timeout'

/**
 * Skatteverket OAuth2 helpers for the `per` (BankID) flow.
 *
 * Endpoints:
 *   Authorize: GET  {base}/authorize
 *   Token:     POST {base}/token
 *
 * The `per` flow is user-facing BankID authentication.
 * No mTLS required (unlike the `org` flow).
 */

const DEFAULT_OAUTH_BASE_URL = 'https://peroauth2.test.skatteverket.se/oauth2/v1/per'
// `agd` is the AGI (arbetsgivardeklaration) scope. Source: SKV's service
// description PDF, Tjänstebeskrivning Arbetsgivardeklaration inlämning v1.7,
// section 4.1.2.2: the 403 "Felaktigt access scope" example shows
// `"description": "The required scope agd has been requested for that access token."`
// The other tokens match the path segments of their respective APIs.
const DEFAULT_SCOPES = 'momsdeklaration inkforetag skahmst skattekonto agd'

function getOAuthBaseUrl(): string {
  return process.env.SKATTEVERKET_OAUTH_BASE_URL || DEFAULT_OAUTH_BASE_URL
}

function getClientId(): string {
  const id = process.env.SKATTEVERKET_OAUTH2_CLIENT_ID
  if (!id) throw new Error('SKATTEVERKET_OAUTH2_CLIENT_ID is required')
  return id
}

function getClientSecret(): string {
  const secret = process.env.SKATTEVERKET_OAUTH2_CLIENT_SECRET
  if (!secret) throw new Error('SKATTEVERKET_OAUTH2_CLIENT_SECRET is required')
  return secret
}

/**
 * Generate a PKCE verifier/challenge pair (RFC 7636, S256 method).
 *
 * SKV's per flow accepts (and on some test client configurations *requires*)
 * PKCE. Without a code_challenge SKV may issue tokens that downstream APIs
 * (notably the AGI APIGW) reject as revoked when called, even though the
 * initial token exchange succeeds. Always sending PKCE is safe regardless
 * of whether SKV strictly requires it.
 *
 * Verifier: 64 random bytes → base64url → 86 chars (within RFC 7636's
 * 43-128 range). Challenge: SHA-256 of the verifier, base64url-encoded.
 */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(64).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * Build the Skatteverket OAuth2 authorization URL.
 * User is redirected here to authenticate with BankID.
 */
export function buildAuthorizeUrl(
  redirectUri: string,
  state: string,
  options?: { scope?: string; codeChallenge?: string }
): string {
  const base = getOAuthBaseUrl()
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: 'code',
    state,
    redirect_uri: redirectUri,
    scope: options?.scope || DEFAULT_SCOPES,
  })
  if (options?.codeChallenge) {
    params.set('code_challenge', options.codeChallenge)
    params.set('code_challenge_method', 'S256')
  }
  return `${base}/authorize?${params.toString()}`
}

/**
 * Exchange an authorization code for tokens.
 * Must be called immediately upon receiving the callback: code expires in 5 minutes.
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  codeVerifier?: string,
): Promise<SkatteverketTokens> {
  const base = getOAuthBaseUrl()

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: getClientId(),
    client_secret: getClientSecret(),
    redirect_uri: redirectUri,
    code,
  })
  if (codeVerifier) body.set('code_verifier', codeVerifier)

  const response = await fetchWithTimeout(
    `${base}/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(),
    },
    {
      timeoutMs: SKATTEVERKET_EXCHANGE_TIMEOUT_MS,
      description: 'Skatteverket token exchange',
    },
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Skatteverket token exchange failed (${response.status}): ${text}`)
  }

  const data = await response.json()

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? null,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    refresh_count: 0,
    scope: data.scope ?? DEFAULT_SCOPES,
  }
}

/**
 * Refresh an access token using a stored refresh token.
 *
 * The `per` flow supports up to 10 refreshes per session.
 * Each refresh returns a NEW refresh_token that must be stored.
 * Refresh tokens are valid for 65 minutes.
 */
export async function refreshAccessToken(
  refreshToken: string,
  previousRefreshCount: number
): Promise<SkatteverketTokens> {
  const base = getOAuthBaseUrl()

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: getClientId(),
    client_secret: getClientSecret(),
    refresh_token: refreshToken,
  })

  const response = await fetchWithTimeout(
    `${base}/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(),
    },
    {
      timeoutMs: OAUTH_TIMEOUT_MS,
      description: 'Skatteverket token refresh',
    },
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Skatteverket token refresh failed (${response.status}): ${text}`)
  }

  const data = await response.json()

  return {
    access_token: data.access_token,
    // Each refresh returns a new refresh_token: must be stored
    refresh_token: data.refresh_token ?? null,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    refresh_count: previousRefreshCount + 1,
    scope: data.scope ?? '',
  }
}
