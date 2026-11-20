import crypto from 'node:crypto'
import { fetchWithTimeout, OAUTH_TIMEOUT_MS, SKATTEVERKET_EXCHANGE_TIMEOUT_MS } from '@/lib/http/fetch-with-timeout'
import { requireHttpsUrl } from '@/lib/http/require-https'

/**
 * Skatteverket OAuth2 (`per`/BankID flow) helpers. The one implementation:
 * the hosted connector broker calls it on behalf of a self-hosted instance
 * (exchanging the code/refresh and returning the tokens for the instance to
 * store), and the skatteverket extension's direct path calls it for its own
 * flow. It lives in core so core does not import from @/extensions/. Same
 * endpoints and client credentials either way (SKV registers ONE integrator
 * = Arcim).
 */

const DEFAULT_OAUTH_BASE_URL = 'https://peroauth2.test.skatteverket.se/oauth2/v1/per'
// `agd` is the AGI (arbetsgivardeklaration) scope. Source: SKV's service
// description PDF, Tjänstebeskrivning Arbetsgivardeklaration inlämning v1.7,
// section 4.1.2.2: the 403 "Felaktigt access scope" example shows
// `"description": "The required scope agd has been requested for that access token."`
// The other tokens match the path segments of their respective APIs,
// EXCEPT skattekonto. The scope names there, learned the hard way:
//   - `ska`       = the interactive skattekonto REST API (saldo +
//                   transaktioner). Requested since the extension's first
//                   commit; removed 2026-05-10 by a "remove unused scopes"
//                   cleanup (#431 series), which instantly broke skattekonto
//                   sync for every token issued after that hour: the API
//                   answers 403 "The required scopes are not authorized"
//                   without it. Re-added 2026-07-20. Do not "clean up" again.
//   - `skahmst`   = a DIFFERENT bulk service (Skattekonto Hämta huvudmäns
//                   saldo och transaktioner, file via E-transport for
//                   juridiska läsombud).
//                   Not what the sync uses, but harmless to request.
//   - `skattekonto` is NOT a real SKV scope name: SKV silently drops it
//                   from every grant. Kept only so a future SKV rename in
//                   our favor costs nothing.
//
// AGI needs TWO scopes, one per backing API, and missing the second one is
// invisible until the very last step of a filing:
//   - `agd`                  = arbetsgivardeklaration/inlamning (POST underlag,
//                              kontrollresultat, spara, skapaGranskningsunderlag).
//   - `agdredovisningperiod` = arbetsgivardeklaration/hanteraredovisningsperiod
//                              (kvittenser, las, lasUpp). Note the spelling:
//                              "redovisningperiod", no genitive s, exactly as
//                              SKV registers it. Added 2026-08-13 after a real
//                              prod filing signed fine and then failed on
//                              "Hämta kvittens" with 403 {"error": "The
//                              required scopes are not authorized"}: the token
//                              carried `agd` only, so the hantera API refused
//                              while inlämning kept working. Same body as the
//                              APIGW subscription gap (#973), which is why the
//                              gateway/token distinction has to be made with
//                              the APIGW client, not from this string alone.
//
// The string is pinned byte for byte in the extension's oauth-direct test.
const DEFAULT_SCOPES = 'momsdeklaration inkforetag skahmst skattekonto ska agd agdredovisningperiod'

/**
 * Every SKV base URL must be https: the OAuth exchange carries Arcim's client
 * secret and the data calls carry the gateway Client_Secret, so a plaintext
 * override would ship credentials unencrypted. requireHttpsUrl throws so a
 * bad env fails the request, never the build; the extension's direct data
 * path runs the same check on its own base URLs (api-client.ts).
 */
export function skvOauthBaseUrl(): string {
  return requireHttpsUrl(process.env.SKATTEVERKET_OAUTH_BASE_URL || DEFAULT_OAUTH_BASE_URL, 'SKATTEVERKET_OAUTH_BASE_URL')
}
export function skvDefaultScopes(): string {
  return DEFAULT_SCOPES
}
function clientId(): string {
  const v = process.env.SKATTEVERKET_OAUTH2_CLIENT_ID
  if (!v) throw new Error('SKATTEVERKET_OAUTH2_CLIENT_ID is required')
  return v
}
function clientSecret(): string {
  const v = process.env.SKATTEVERKET_OAUTH2_CLIENT_SECRET
  if (!v) throw new Error('SKATTEVERKET_OAUTH2_CLIENT_SECRET is required')
  return v
}

export function buildSkvAuthorizeUrl(
  redirectUri: string,
  state: string,
  options?: { scope?: string; codeChallenge?: string },
): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    state,
    redirect_uri: redirectUri,
    scope: options?.scope || DEFAULT_SCOPES,
  })
  if (options?.codeChallenge) {
    params.set('code_challenge', options.codeChallenge)
    params.set('code_challenge_method', 'S256')
  }
  return `${skvOauthBaseUrl()}/authorize?${params.toString()}`
}

export interface SkvTokenResponse {
  access_token: string
  refresh_token: string | null
  expires_in: number
  scope: string
}

/** Raw token exchange, returned verbatim to the instance (it stores them). */
export async function exchangeSkvCode(code: string, redirectUri: string, codeVerifier?: string): Promise<SkvTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri,
    code,
  })
  if (codeVerifier) body.set('code_verifier', codeVerifier)
  return postToken(body, SKATTEVERKET_EXCHANGE_TIMEOUT_MS, 'Skatteverket token exchange')
}

/**
 * SKV's terminal dead-refresh-token dialects, matched against the error
 * message postToken throws (which embeds status + body). The same set the
 * instance-side extension classifies as SESSION_EXPIRED on the direct path:
 * 404 id_not_found / "refresh token is not found", 400 "Refresh Token status
 * is expired", and OAuth2's standard 400 invalid_grant. `per`-flow refresh
 * tokens live 65 minutes, so this is the DOMINANT refresh outcome, not an
 * edge case: the broker must distinguish it from transient failures or every
 * connector instance loses its reconnect flow (skeptic refutation on PR6b-2).
 * Config-shaped 400s (invalid_client, invalid_scope) deliberately do NOT
 * match: a reconnect cannot fix those.
 */
export function isSkvDeadRefreshTokenError(message: string): boolean {
  return (
    (/\b404\b/.test(message) && /id_not_found|refresh token is not found/i.test(message)) ||
    (/\b400\b/.test(message) &&
      (/refresh token status is expired/i.test(message) ||
        /"error"\s*:\s*"invalid_grant"/i.test(message)))
  )
}

export async function refreshSkvToken(refreshToken: string): Promise<SkvTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
  })
  return postToken(body, OAUTH_TIMEOUT_MS, 'Skatteverket token refresh')
}

async function postToken(body: URLSearchParams, timeoutMs: number, description: string): Promise<SkvTokenResponse> {
  const response = await fetchWithTimeout(
    `${skvOauthBaseUrl()}/token`,
    // redirect 'error': a 307/308 would resend client_secret + code/refresh
    // token to the redirect target.
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: body.toString(), redirect: 'error' },
    { timeoutMs, description },
  )
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${description} failed (${response.status}): ${text}`)
  }
  const data = (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? null,
    expires_in: data.expires_in ?? 3600,
    scope: data.scope ?? DEFAULT_SCOPES,
  }
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(64).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * The Skatteverket data-API base URLs, keyed by the short service segment the
 * connector proxy exposes. One integrator, several backing APIs; the instance
 * addresses them as /api/connect/skv/api/<service>/<path>.
 */
export const SKV_API_BASES: Record<string, () => string> = {
  moms: () => requireHttpsUrl(process.env.SKATTEVERKET_API_BASE_URL || 'https://api.test.skatteverket.se/momsdeklaration/v1', 'SKATTEVERKET_API_BASE_URL'),
  skattekonto: () => requireHttpsUrl(process.env.SKATTEVERKET_SKATTEKONTO_API_BASE_URL || 'https://api.test.skatteverket.se/beskattning/skattekonto/v2', 'SKATTEVERKET_SKATTEKONTO_API_BASE_URL'),
  'agd-inlamning': () => requireHttpsUrl(process.env.SKATTEVERKET_AGD_INLAMNING_API_BASE_URL || 'https://api.test.skatteverket.se/arbetsgivardeklaration/inlamning/v1', 'SKATTEVERKET_AGD_INLAMNING_API_BASE_URL'),
  'agd-period': () => requireHttpsUrl(process.env.SKATTEVERKET_AGD_PERIOD_API_BASE_URL || 'https://api.test.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1', 'SKATTEVERKET_AGD_PERIOD_API_BASE_URL'),
}

function apigwClientId(): string {
  const v = process.env.SKATTEVERKET_APIGW_CLIENT_ID
  if (!v) throw new Error('SKATTEVERKET_APIGW_CLIENT_ID is required')
  return v
}
function apigwClientSecret(): string {
  const v = process.env.SKATTEVERKET_APIGW_CLIENT_SECRET
  if (!v) throw new Error('SKATTEVERKET_APIGW_CLIENT_SECRET is required')
  return v
}

/** The API-gateway headers Arcim's registered client must add to every SKV data call. */
export function skvGatewayHeaders(): Record<string, string> {
  return {
    Client_Id: apigwClientId(),
    Client_Secret: apigwClientSecret(),
    skv_client_correlation_id: crypto.randomUUID(),
  }
}
