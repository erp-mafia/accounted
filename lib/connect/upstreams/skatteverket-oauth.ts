import crypto from 'node:crypto'
import { fetchWithTimeout, OAUTH_TIMEOUT_MS, SKATTEVERKET_EXCHANGE_TIMEOUT_MS } from '@/lib/http/fetch-with-timeout'

/**
 * Skatteverket OAuth2 (`per`/BankID flow) helpers for the hosted connector
 * broker. The instance-side extension has its own copy (it runs its own flow
 * on hosted); this module is the CORE copy the connector proxy uses, so core
 * does not import from @/extensions/. Same endpoints and client credentials
 * (SKV registers ONE integrator = Arcim), the difference is only who calls:
 * here the hosted proxy exchanges the code/refresh on behalf of a self-hosted
 * instance and returns the tokens for the instance to store.
 */

const DEFAULT_OAUTH_BASE_URL = 'https://peroauth2.test.skatteverket.se/oauth2/v1/per'
// AGI needs both agd and agdredovisningperiod; skattekonto needs ska (do not
// "clean up"): the exact set is documented in the extension's oauth.ts.
const DEFAULT_SCOPES = 'momsdeklaration inkforetag skahmst skattekonto ska agd agdredovisningperiod'

/**
 * Every SKV base URL must be https (http only for loopback dev): the OAuth
 * exchange carries Arcim's client secret and the data calls carry the
 * gateway Client_Secret, so a plaintext override would ship credentials
 * unencrypted. Throws so a bad env fails the request, never the build.
 */
function httpsOnly(raw: string, name: string): string {
  const url = new URL(raw)
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must be https: Skatteverket credentials ride in these requests`)
  }
  return raw
}

export function skvOauthBaseUrl(): string {
  return httpsOnly(process.env.SKATTEVERKET_OAUTH_BASE_URL || DEFAULT_OAUTH_BASE_URL, 'SKATTEVERKET_OAUTH_BASE_URL')
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
  moms: () => httpsOnly(process.env.SKATTEVERKET_API_BASE_URL || 'https://api.test.skatteverket.se/momsdeklaration/v1', 'SKATTEVERKET_API_BASE_URL'),
  skattekonto: () => httpsOnly(process.env.SKATTEVERKET_SKATTEKONTO_API_BASE_URL || 'https://api.test.skatteverket.se/beskattning/skattekonto/v2', 'SKATTEVERKET_SKATTEKONTO_API_BASE_URL'),
  'agd-inlamning': () => httpsOnly(process.env.SKATTEVERKET_AGD_INLAMNING_API_BASE_URL || 'https://api.test.skatteverket.se/arbetsgivardeklaration/inlamning/v1', 'SKATTEVERKET_AGD_INLAMNING_API_BASE_URL'),
  'agd-period': () => httpsOnly(process.env.SKATTEVERKET_AGD_PERIOD_API_BASE_URL || 'https://api.test.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1', 'SKATTEVERKET_AGD_PERIOD_API_BASE_URL'),
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
