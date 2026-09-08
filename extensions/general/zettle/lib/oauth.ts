/**
 * Zettle partner-hosted OAuth 2.0 (authorization code grant).
 *
 * Scopes: READ:PURCHASE (Purchase API) + READ:USERINFO (users/self for the
 * organization UUID that becomes store_scope). Refresh tokens rotate: every
 * refresh returns a new refresh token that MUST replace the previous one.
 */

import {
  fetchWithTimeout,
  OAUTH_TIMEOUT_MS,
  OAUTH_REVOKE_TIMEOUT_MS,
} from '@/lib/http/fetch-with-timeout'
import { isZettleConfigured } from './credentials'
import type { ZettleTokenPair, ZettleUserSelf } from '../types'

const AUTH_ENDPOINT = 'https://oauth.zettle.com/authorize'
const TOKEN_ENDPOINT = 'https://oauth.zettle.com/token'
const USERS_SELF_ENDPOINT = 'https://oauth.zettle.com/users/self'
const DISCONNECT_ENDPOINT = 'https://oauth.zettle.com/application-connections/self'

/** Space-separated scopes requested at authorize time. */
export const ZETTLE_OAUTH_SCOPES = 'READ:PURCHASE READ:USERINFO'

export function getZettleClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.ZETTLE_CLIENT_ID
  const clientSecret = process.env.ZETTLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('Zettle OAuth is not configured: set ZETTLE_CLIENT_ID and ZETTLE_CLIENT_SECRET')
  }
  return { clientId, clientSecret }
}

export function getZettleRedirectUri(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL
  if (!base) {
    throw new Error('NEXT_PUBLIC_APP_URL is required for Zettle OAuth')
  }
  return `${base.replace(/\/$/, '')}/api/extensions/zettle/callback`
}

export function buildAuthorizeUrl(state: string): string {
  if (!isZettleConfigured()) {
    throw new Error('Zettle is not configured')
  }
  const { clientId } = getZettleClientCredentials()
  const params = new URLSearchParams({
    response_type: 'code',
    scope: ZETTLE_OAUTH_SCOPES,
    client_id: clientId,
    redirect_uri: getZettleRedirectUri(),
    state,
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

async function postToken(body: URLSearchParams): Promise<ZettleTokenPair> {
  const res = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      // Node fetch can replay POST bodies across 307/308 redirects, including
      // cross-origin. Refuse redirects so client_secret never leaves oauth.zettle.com.
      redirect: 'error',
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Zettle token exchange' },
  )
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new ZettleOAuthError(
      `Zettle token exchange failed: ${res.status}${errText ? ` ${errText}` : ''}`,
      res.status,
    )
  }
  const json = (await res.json()) as Partial<ZettleTokenPair>
  if (typeof json.access_token !== 'string' || !json.access_token) {
    throw new ZettleOAuthError('Zettle token exchange returned no access token', 0)
  }
  if (typeof json.refresh_token !== 'string' || !json.refresh_token) {
    throw new ZettleOAuthError('Zettle token exchange returned no refresh token', 0)
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: typeof json.expires_in === 'number' ? json.expires_in : 7200,
  }
}

export async function exchangeCodeForTokens(code: string): Promise<ZettleTokenPair> {
  const { clientId, clientSecret } = getZettleClientCredentials()
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getZettleRedirectUri(),
  })
  return postToken(body)
}

/**
 * Exchange a refresh token for a new access + refresh pair. Callers MUST
 * persist the new refresh_token (Zettle rotates it on every refresh).
 */
export async function refreshAccessToken(refreshToken: string): Promise<ZettleTokenPair> {
  const { clientId, clientSecret } = getZettleClientCredentials()
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  })
  return postToken(body)
}

export async function fetchUserSelf(accessToken: string): Promise<ZettleUserSelf> {
  const res = await fetchWithTimeout(
    USERS_SELF_ENDPOINT,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Zettle users/self' },
  )
  if (!res.ok) {
    throw new ZettleOAuthError(`Zettle users/self failed: ${res.status}`, res.status)
  }
  const json = (await res.json()) as Partial<ZettleUserSelf>
  if (typeof json.organizationUuid !== 'string' || !json.organizationUuid) {
    throw new ZettleOAuthError('Zettle users/self returned no organizationUuid', 0)
  }
  return {
    uuid: typeof json.uuid === 'string' ? json.uuid : '',
    organizationUuid: json.organizationUuid,
  }
}

/** Best-effort remote revoke; local revoke still proceeds if this fails. */
export async function disconnectApplication(accessToken: string): Promise<void> {
  try {
    await fetchWithTimeout(
      DISCONNECT_ENDPOINT,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      },
      { timeoutMs: OAUTH_REVOKE_TIMEOUT_MS, description: 'Zettle disconnect' },
    )
  } catch {
    // Remote revoke is best-effort.
  }
}

export class ZettleOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ZettleOAuthError'
  }
}

export function isRevokedOAuthError(error: unknown): boolean {
  if (!(error instanceof ZettleOAuthError)) return false
  return error.status === 400 || error.status === 401 || error.status === 403
}
