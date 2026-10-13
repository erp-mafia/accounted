/**
 * Minimal Google OAuth 2.0 client for the cloud-backup extension.
 *
 * Scope: `drive.file`: app-created files only, not the user's full Drive.
 * Access type: `offline`: returns a refresh token on first consent.
 * Prompt: `consent`: forces the consent screen so the refresh token is
 *   re-issued even if the user has previously authorised the app.
 *
 * The endpoints and the request shape are shared with the mail extension
 * (lib/auth/google-oauth.ts); the client, scope and error mapping are ours.
 */

import { fetchWithTimeout, OAUTH_TIMEOUT_MS } from '@/lib/http/fetch-with-timeout'
import { CloudTokenRefreshError } from './cloud-provider'
import { revokeGoogleToken } from '@/lib/auth/google-revoke'
import {
  buildGoogleConsentUrl,
  exchangeGoogleCode,
  refreshGoogleAccessToken,
  type GoogleOAuthClient,
} from '@/lib/auth/google-oauth'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'

export type OAuthEnv = GoogleOAuthClient

/**
 * Whether this deployment can run the Google flow at all. Checked before the
 * UI offers a connect button, so a missing credential renders as a disabled
 * row instead of a failed OAuth round-trip.
 */
export function isGoogleOAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
}

export function getOAuthEnv(origin: string): OAuthEnv {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google OAuth is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET'
    )
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${origin}/api/extensions/ext/cloud-backup/oauth/callback`,
  }
}

export function buildAuthorizationUrl(env: OAuthEnv, state: string): string {
  return buildGoogleConsentUrl(env, {
    scope: `openid email ${DRIVE_SCOPE}`,
    state,
    includeGrantedScopes: true,
  })
}

export interface TokenExchangeResult {
  access_token: string
  refresh_token: string
  expires_in: number
  id_token?: string
}

export async function exchangeCodeForTokens(
  env: OAuthEnv,
  code: string
): Promise<TokenExchangeResult> {
  const res = await exchangeGoogleCode(env, code, {
    timeoutMs: OAUTH_TIMEOUT_MS,
    description: 'Google token exchange',
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Google token exchange failed: ${res.status} ${errText}`)
  }
  const json = (await res.json()) as TokenExchangeResult
  if (!json.refresh_token) {
    throw new Error(
      'No refresh token returned: Google only issues one on first consent. ' +
        'Revoke the app at myaccount.google.com/permissions and try again.'
    )
  }
  return json
}

export interface AccessTokenResult {
  access_token: string
  expires_in: number
}

/**
 * Thrown when Google's token endpoint rejects a refresh attempt. Carries the
 * HTTP status and raw response body so callers can distinguish a permanently
 * dead refresh token (400 invalid_grant) from transient failures.
 *
 * Extends the provider-agnostic {@link CloudTokenRefreshError} so `performSync`
 * can handle a dead token identically whatever the destination is.
 */
export class GoogleTokenRefreshError extends CloudTokenRefreshError {
  constructor(status: number, body: string) {
    super('Google', status, body)
    this.name = 'GoogleTokenRefreshError'
  }
}

export async function refreshAccessToken(
  env: OAuthEnv,
  refreshToken: string
): Promise<AccessTokenResult> {
  const res = await refreshGoogleAccessToken(env, refreshToken, {
    timeoutMs: OAUTH_TIMEOUT_MS,
    description: 'Google token refresh',
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new GoogleTokenRefreshError(res.status, errText)
  }
  return (await res.json()) as AccessTokenResult
}

/**
 * Best-effort revoke: never throws, so a disconnect still completes locally.
 * The token goes in the request body, never in the URL, where proxies and
 * request logs keep it.
 */
export async function revokeToken(token: string): Promise<void> {
  await revokeGoogleToken(token)
}

export async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await fetchWithTimeout(
    USERINFO_ENDPOINT,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Google userinfo fetch' },
  )
  if (!res.ok) {
    throw new Error(`Failed to fetch Google user info: ${res.status}`)
  }
  const json = (await res.json()) as { email?: string }
  return json.email || 'unknown@google'
}
