/**
 * Revoking a Google OAuth grant, for every extension that holds one (mail,
 * cloud backup).
 */
import { OAUTH_REVOKE_TIMEOUT_MS } from '@/lib/http/fetch-with-timeout'

const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

/**
 * What Google answered when asked to revoke a grant.
 *
 *   revoked          Google confirmed it (200).
 *   already_invalid  Google no longer knows the token (400 invalid_token):
 *                    the person removed the app at myaccount.google.com, or
 *                    the grant was revoked or expired before. Nothing is left.
 *   failed           no confirmation: a timeout, a network error, any other
 *                    answer.
 */
export type GoogleRevocationOutcome = 'revoked' | 'already_invalid' | 'failed'

export interface GoogleRevocationResult {
  outcome: GoogleRevocationOutcome
  /** HTTP status, or null when no answer arrived. */
  status: number | null
  /** Google's error code or the local error's name. Never the token. */
  error: string | null
}

/**
 * Revoke a grant at Google, so deleting our copy of a token is not the only
 * thing that ends the access.
 *
 * Revoking a refresh token also revokes the access tokens issued from it, and
 * the app leaves the account's list of third-party access, so this is treated
 * as ending the app's access to that Google account rather than to one token.
 * Callers that may hold the same account under several connections check
 * that first (the mail extension's revokeStoredGrant).
 *
 * The token goes in a form-encoded body, never in the URL, where proxies and
 * request logs keep it. Best effort by contract: it never throws, so a slow
 * or broken Google can never block the deletion that follows it.
 */
export async function revokeGoogleToken(token: string): Promise<GoogleRevocationResult> {
  try {
    const response = await fetch(REVOKE_ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(OAUTH_REVOKE_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    })
    if (response.ok) return { outcome: 'revoked', status: response.status, error: null }
    const body = (await response.json().catch(() => ({}))) as { error?: unknown }
    const error = typeof body.error === 'string' ? body.error.slice(0, 64) : null
    return {
      outcome: response.status === 400 && error === 'invalid_token' ? 'already_invalid' : 'failed',
      status: response.status,
      error,
    }
  } catch (err) {
    // A TimeoutError or a network failure. The name only: nothing that could
    // echo the request body into a log line.
    return { outcome: 'failed', status: null, error: err instanceof Error ? err.name : 'unknown' }
  }
}
