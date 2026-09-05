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

export function buildAuthorizationUrl(env: GoogleOAuthEnv, state: string): string {
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
  if (!body.refresh_token) {
    // Google withholds it when the user has an older grant for this client.
    // Say so plainly: the fix is to revoke at myaccount.google.com and retry,
    // and a connection without one is useless the moment the hour is up.
    throw new Error(
      'Google returned no refresh token. Remove the previous access for this app at myaccount.google.com/permissions and connect again.',
    )
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
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
