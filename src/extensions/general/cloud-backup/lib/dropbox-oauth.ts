/**
 * Minimal Dropbox OAuth 2.0 client for the cloud-backup extension.
 *
 * Access type: **App folder**. Dropbox confines the app to its own
 * `Apps/<app name>/` directory, so every path we use is relative to that
 * folder and the app can never read the rest of the user's Dropbox. This
 * mirrors the privacy posture of the Google `drive.file` scope.
 *
 * `token_access_type=offline` is what makes Dropbox return a refresh token;
 * without it the grant yields a short-lived access token only and the nightly
 * cron would stop working after a few hours.
 */

import {
  fetchWithTimeout,
  OAUTH_TIMEOUT_MS,
  OAUTH_REVOKE_TIMEOUT_MS,
} from '@/lib/http/fetch-with-timeout'
import { CloudTokenRefreshError } from './cloud-provider'

const AUTH_ENDPOINT = 'https://www.dropbox.com/oauth2/authorize'
const TOKEN_ENDPOINT = 'https://api.dropboxapi.com/oauth2/token'
const REVOKE_ENDPOINT = 'https://api.dropboxapi.com/2/auth/token/revoke'
const ACCOUNT_ENDPOINT = 'https://api.dropboxapi.com/2/users/get_current_account'

/**
 * Write + read the app folder, and read the account identity for the "connected
 * as" line in the UI. Read access is requested because a restore-side feature
 * (and support diagnosing a partial backup) needs to list what is actually
 * there; without it the app is write-only and cannot verify its own output.
 */
const SCOPES = ['files.content.write', 'files.content.read', 'account_info.read']

export interface DropboxOAuthEnv {
  appKey: string
  appSecret: string
  redirectUri: string
}

/** Callback path, kept next to the URL builder so the two cannot drift. */
export const DROPBOX_CALLBACK_PATH = '/oauth/dropbox/callback'

export function isDropboxOAuthConfigured(): boolean {
  return Boolean(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET)
}

export function getDropboxOAuthEnv(origin: string): DropboxOAuthEnv {
  const appKey = process.env.DROPBOX_APP_KEY
  const appSecret = process.env.DROPBOX_APP_SECRET
  if (!appKey || !appSecret) {
    throw new Error(
      'Dropbox OAuth is not configured: set DROPBOX_APP_KEY and DROPBOX_APP_SECRET'
    )
  }
  return {
    appKey,
    appSecret,
    redirectUri: `${origin}/api/extensions/ext/cloud-backup${DROPBOX_CALLBACK_PATH}`,
  }
}

export function buildDropboxAuthorizationUrl(
  env: DropboxOAuthEnv,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: env.appKey,
    redirect_uri: env.redirectUri,
    response_type: 'code',
    token_access_type: 'offline',
    scope: SCOPES.join(' '),
    // Re-consent on every connect so a reconnect always yields a fresh refresh
    // token, matching the Google flow's `prompt=consent`.
    force_reapprove: 'true',
    state,
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

export interface DropboxTokenExchangeResult {
  access_token: string
  refresh_token: string
  expires_in: number
  account_id?: string
}

export async function exchangeDropboxCodeForTokens(
  env: DropboxOAuthEnv,
  code: string
): Promise<DropboxTokenExchangeResult> {
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: env.appKey,
    client_secret: env.appSecret,
    redirect_uri: env.redirectUri,
  })
  const res = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Dropbox token exchange' }
  )
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Dropbox token exchange failed: ${res.status} ${errText}`)
  }
  const json = (await res.json()) as DropboxTokenExchangeResult
  if (!json.refresh_token) {
    throw new Error(
      'No refresh token returned: the authorization request must use ' +
        'token_access_type=offline.'
    )
  }
  return json
}

/**
 * Thrown when Dropbox's token endpoint rejects a refresh. Shares
 * {@link CloudTokenRefreshError}'s `invalid_grant` detection: Dropbox returns
 * `400 {"error": "invalid_grant"}` once the user disconnects the app.
 */
export class DropboxTokenRefreshError extends CloudTokenRefreshError {
  constructor(status: number, body: string) {
    super('Dropbox', status, body)
    this.name = 'DropboxTokenRefreshError'
  }
}

export async function refreshDropboxAccessToken(
  env: DropboxOAuthEnv,
  refreshToken: string
): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.appKey,
    client_secret: env.appSecret,
  })
  const res = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Dropbox token refresh' }
  )
  if (!res.ok) {
    const errText = await res.text()
    throw new DropboxTokenRefreshError(res.status, errText)
  }
  return (await res.json()) as { access_token: string; expires_in: number }
}

/**
 * Revoke the grant. Dropbox revokes by *access* token (there is no
 * refresh-token revoke endpoint), so the caller mints a short-lived one first.
 * Best-effort: a failed revoke must not block the local disconnect.
 */
export async function revokeDropboxToken(accessToken: string): Promise<void> {
  try {
    await fetchWithTimeout(
      REVOKE_ENDPOINT,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      { timeoutMs: OAUTH_REVOKE_TIMEOUT_MS, description: 'Dropbox token revoke' }
    )
  } catch {
    // Swallow timeouts and network errors so disconnect flows still complete locally.
  }
}

export async function fetchDropboxAccountEmail(accessToken: string): Promise<string> {
  // An RPC endpoint taking no arguments: send no body and no Content-Type,
  // otherwise Dropbox rejects the call as a malformed request.
  const res = await fetchWithTimeout(
    ACCOUNT_ENDPOINT,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Dropbox account fetch' }
  )
  if (!res.ok) {
    throw new Error(`Failed to fetch Dropbox account info: ${res.status}`)
  }
  const json = (await res.json()) as { email?: string }
  return json.email || 'unknown@dropbox'
}
