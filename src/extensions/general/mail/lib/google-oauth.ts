/**
 * Gmail OAuth, read-only.
 *
 * The scope is `gmail.readonly` and nothing else. That is enough to search and
 * to download attachment bytes (verified against Google's method-scope table),
 * and it structurally cannot send, modify or delete: the promise made in the
 * consent screen is enforced by the grant, not by our code being careful.
 *
 * Exactly one scope, on purpose. Google's restricted-scope review compares the
 * scopes the authorization URL requests with the ones declared in the Cloud
 * Console, string for string, and bounced the first submission because the
 * URL also carried `openid email`. Those only served to learn the mailbox
 * address, which Gmail's profile endpoint returns under gmail.readonly anyway
 * (getMailboxAddress in gmail-client.ts). Adding a scope here means adding it
 * in the console and re-recording the demo video.
 *
 * Consequence worth remembering: because we never hold a send scope, the agent
 * can prepare a forward for the user but can never send one itself.
 */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

/**
 * Whether Google's own answer shows that a grant cannot read Gmail.
 *
 * Google's consent screen lets a person untick a scope and still approve, so
 * a grant can come back without the one scope that makes it useful. Only a
 * stated list that leaves gmail.readonly out counts as that. An empty list
 * means Google did not state the scopes at all, which RFC 6749 (5.1) defines
 * as "identical to the scope requested", and the request is gmail.readonly
 * alone. Treating empty as missing would park a working mailbox on a guess,
 * while a grant that truly lacks the scope still shows up as a failed search.
 */
export function lacksGmailScope(scopes: readonly string[] | null | undefined): boolean {
  return Array.isArray(scopes) && scopes.length > 0 && !scopes.includes(GMAIL_READONLY_SCOPE)
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
/**
 * Deadline on the token endpoint.
 *
 * A refresh happens inside every mailbox search, and searches run with
 * Promise.all, so a stalled token endpoint would hold the whole company's hunt
 * open. On timeout the connection simply yields nothing this run.
 */
export const TOKEN_TIMEOUT_MS = 15_000

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

export interface GoogleOAuthEnv {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/**
 * Deliberately distinct from cloud-backup's GOOGLE_CLIENT_ID: that is a
 * different OAuth client, in a different project, owned by a different founder,
 * and sharing the pair would let one integration's credential rotation break
 * the other.
 */
export function isGoogleMailConfigured(): boolean {
  return Boolean(process.env.GOOGLE_MAIL_CLIENT_ID && process.env.GOOGLE_MAIL_CLIENT_SECRET)
}

export function getGoogleOAuthEnv(origin: string): GoogleOAuthEnv {
  const clientId = process.env.GOOGLE_MAIL_CLIENT_ID
  const clientSecret = process.env.GOOGLE_MAIL_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('Gmail is not configured: set GOOGLE_MAIL_CLIENT_ID and GOOGLE_MAIL_CLIENT_SECRET')
  }
  return {
    clientId,
    clientSecret,
    // Must match the string registered in the Google console exactly; the
    // extension slug `mail` is pinned for that reason.
    redirectUri: `${origin}/api/extensions/ext/mail/oauth/callback`,
  }
}

export function buildAuthorizationUrl(env: GoogleOAuthEnv, state: string, codeChallenge?: string): string {
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: env.redirectUri,
    response_type: 'code',
    scope: GMAIL_READONLY_SCOPE,
    // Signed, self-expiring CSRF token. The callback refuses anything without
    // it, so omitting this breaks the flow as well as the protection.
    state,
    // offline + consent is what returns a refresh token at all; without it a
    // grant dies in an hour and the nightly hunt silently stops.
    access_type: 'offline',
    // No include_granted_scopes: it lets Google add scopes this app was granted
    // elsewhere to the token it returns here, so a mailbox grant could quietly
    // carry more authority than the consent screen showed.
    prompt: 'consent',
  })
  // PKCE (RFC 7636): the code is only redeemable with the verifier sealed in
  // the state. Changes nothing about the scope Google reviews.
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge)
    params.set('code_challenge_method', 'S256')
  }
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

export interface GoogleTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
  scopes: string[]
}

/** Raised when a grant is dead rather than the request being unlucky. */
export class MailTokenRefreshError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message)
    this.name = 'MailTokenRefreshError'
  }
}

export async function exchangeCodeForTokens(
  env: GoogleOAuthEnv,
  code: string,
  /** The PKCE verifier from the state; null for a flow started without one. */
  codeVerifier: string | null = null,
): Promise<GoogleTokens> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: env.redirectUri,
      grant_type: 'authorization_code',
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }),
  })
  const body = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    error?: string
    error_description?: string
  }
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || body.error || 'Token exchange failed')
  }
  return {
    accessToken: body.access_token,
    // Null rather than a throw, so the callback can check the granted scopes
    // first and then say which of the two went wrong. Google withholds a
    // refresh token when the account already holds a grant for this client;
    // the callback answers `no_refresh_token`, whose fix is removing the old
    // access at myaccount.google.com/permissions and connecting again.
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
    scopes: (body.scope ?? '').split(' ').filter(Boolean),
  }
}

export async function refreshAccessToken(
  env: GoogleOAuthEnv,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.clientId,
      client_secret: env.clientSecret,
      grant_type: 'refresh_token',
    }),
  })
  const body = (await response.json()) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!response.ok || !body.access_token) {
    // invalid_grant means revoked, expired or password-changed: retrying every
    // night would just burn quota, so it is flagged permanent and the
    // connection is parked as needs_reconsent.
    const permanent = body.error === 'invalid_grant'
    throw new MailTokenRefreshError(
      body.error_description || body.error || 'Token refresh failed',
      permanent,
    )
  }
  return {
    accessToken: body.access_token,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
  }
}

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
 * Callers that may hold the same mailbox under several connections check that
 * first (revokeStoredGrant in connections.ts).
 *
 * The token goes in a form-encoded body, never in the URL, where proxies and
 * request logs keep it. Best effort by contract: it never throws, so a slow
 * or broken Google can never block the deletion that follows it.
 */
export async function revokeGoogleToken(token: string): Promise<GoogleRevocationResult> {
  try {
    const response = await fetch(REVOKE_ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
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
