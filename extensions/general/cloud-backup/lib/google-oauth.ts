/**
 * Minimal Google OAuth 2.0 client for the cloud-backup extension.
 *
 * Scope: `drive.file`: app-created files only, not the user's full Drive.
 * Access type: `offline`: returns a refresh token on first consent.
 * Prompt: `consent`: forces the consent screen so the refresh token is
 *   re-issued even if the user has previously authorised the app.
 */

import {
  fetchWithTimeout,
  OAUTH_TIMEOUT_MS,
  OAUTH_REVOKE_TIMEOUT_MS,
} from '@/lib/http/fetch-with-timeout'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'

export interface OAuthEnv {
  clientId: string
  clientSecret: string
  redirectUri: string
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
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: env.redirectUri,
    response_type: 'code',
    scope: `openid email ${DRIVE_SCOPE}`,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
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
  const body = new URLSearchParams({
    code,
    client_id: env.clientId,
    client_secret: env.clientSecret,
    redirect_uri: env.redirectUri,
    grant_type: 'authorization_code',
  })
  const res = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Google token exchange' },
  )
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

export async function refreshAccessToken(
  env: OAuthEnv,
  refreshToken: string
): Promise<AccessTokenResult> {
  const body = new URLSearchParams({
    client_id: env.clientId,
    client_secret: env.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const res = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Google token refresh' },
  )
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Google token refresh failed: ${res.status} ${errText}`)
  }
  return (await res.json()) as AccessTokenResult
}

export async function revokeToken(token: string): Promise<void> {
  try {
    await fetchWithTimeout(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
      { timeoutMs: OAUTH_REVOKE_TIMEOUT_MS, description: 'Google token revoke' },
    )
  } catch {
    // Best-effort revoke: swallow timeouts and network errors so disconnect flows still complete locally.
  }
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
