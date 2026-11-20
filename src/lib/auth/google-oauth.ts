/**
 * Google OAuth 2.0 for every extension that holds a Google grant (mail, cloud
 * backup): the consent URL and the token endpoint.
 *
 * Each extension keeps what is its own: the OAuth client (mail and cloud
 * backup are different Google projects), the scope Google reviewed, and how a
 * refused answer is reported. What lives here is what was copied: the two
 * endpoints, an offline grant with explicit consent, a form-encoded body
 * (codes and tokens never go in a URL, where proxies and request logs keep
 * them), and a deadline on every token request.
 *
 * The token calls return Google's Response untouched, so each caller reads the
 * answer exactly as before. Revoking a grant is google-revoke.ts.
 */
import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

export interface GoogleOAuthClient {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface GoogleConsentRequest {
  /** Space-separated, exactly as declared in the Google Cloud Console. */
  scope: string
  /** Signed, self-expiring CSRF token the callback checks. */
  state: string
  /** PKCE S256 challenge (RFC 7636); the verifier rides in the state. */
  codeChallenge?: string
  /**
   * Lets Google add scopes this client was granted elsewhere to the token.
   * Mail leaves it off: a mailbox grant must not carry more authority than
   * its consent screen showed.
   */
  includeGrantedScopes?: boolean
}

/**
 * The consent URL. Always an offline grant with explicit consent: that is
 * what returns a refresh token at all, so a grant does not die in an hour.
 */
export function buildGoogleConsentUrl(client: GoogleOAuthClient, request: GoogleConsentRequest): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: request.scope,
    access_type: 'offline',
    prompt: 'consent',
    state: request.state,
  })
  if (request.includeGrantedScopes) params.set('include_granted_scopes', 'true')
  if (request.codeChallenge) {
    params.set('code_challenge', request.codeChallenge)
    params.set('code_challenge_method', 'S256')
  }
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

export interface GoogleTokenRequestOptions {
  timeoutMs: number
  /** Names the call in a timeout error, e.g. "Gmail token refresh". */
  description: string
}

function postToTokenEndpoint(form: Record<string, string>, options: GoogleTokenRequestOptions): Promise<Response> {
  return fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    },
    options,
  )
}

/** Redeem an authorization code. `codeVerifier` is the PKCE verifier, when the flow has one. */
export function exchangeGoogleCode(
  client: GoogleOAuthClient,
  code: string,
  options: GoogleTokenRequestOptions & { codeVerifier?: string | null },
): Promise<Response> {
  return postToTokenEndpoint(
    {
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
      grant_type: 'authorization_code',
      ...(options.codeVerifier ? { code_verifier: options.codeVerifier } : {}),
    },
    options,
  )
}

/** Trade a refresh token for a fresh access token. */
export function refreshGoogleAccessToken(
  client: GoogleOAuthClient,
  refreshToken: string,
  options: GoogleTokenRequestOptions,
): Promise<Response> {
  return postToTokenEndpoint(
    {
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: 'refresh_token',
    },
    options,
  )
}
