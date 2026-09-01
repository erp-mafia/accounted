import {
  skatteverketConnectorMode,
  type ConnectorUpstream,
} from '@/lib/connect/instance/upstreams'
import {
  fetchWithTimeout,
  OAUTH_TIMEOUT_MS,
  SKATTEVERKET_EXCHANGE_TIMEOUT_MS,
} from '@/lib/http/fetch-with-timeout'

/**
 * Instance-side helpers for running the Skatteverket extension through the
 * hosted connector broker (/api/connect/skv on app.gnubok.se) instead of
 * against Skatteverket directly.
 *
 * Active only when skatteverketConnectorMode() returns non-null: the instance
 * has GNUBOK_CONNECTOR_KEY set AND no own SKV credentials
 * (SKATTEVERKET_OAUTH2_CLIENT_ID / SKATTEVERKET_APIGW_CLIENT_ID). Hosted
 * always has own credentials, so hosted never takes any branch in this file.
 *
 * The division of labor (plan WS3 PR5b/PR6b):
 * - OAuth: the broker builds the authorize URL against Arcim's registered SKV
 *   client and exchanges/refreshes with Arcim's client secret; the TOKENS are
 *   returned to the instance, which stores them encrypted. client_id and
 *   client_secret never exist on the instance.
 * - Data: the instance sends the user's SKV Bearer as
 *   X-Connector-Upstream-Authorization and its connector key as the regular
 *   Authorization; the proxy adds Arcim's Client_Id/Client_Secret gateway
 *   headers and forwards to the allowlisted backing API.
 */

export { skatteverketConnectorMode }
export type { ConnectorUpstream }

export type SkvConnectorService = 'moms' | 'skattekonto' | 'agd-inlamning' | 'agd-period'

/**
 * The env-var identities and defaults per backing API, mirroring the
 * broker-side allowlist (SKV_API_BASES in lib/connect/upstreams/
 * skatteverket-oauth.ts) and the per-service clients here (api-client.ts
 * getApiBaseUrl, skattekonto-client.ts, agi-client.ts). Both test and prod
 * defaults are listed: in connector mode the instance's own base URLs are
 * usually unset, so the clients pass their test defaults, and the SERVICE
 * segment is all the proxy needs (the actual upstream host is resolved from
 * hosted's env, never from the instance's).
 */
const SERVICE_BASES: ReadonlyArray<{
  service: SkvConnectorService
  envVar: string
  defaults: readonly string[]
}> = [
  {
    service: 'moms',
    envVar: 'SKATTEVERKET_API_BASE_URL',
    defaults: [
      'https://api.test.skatteverket.se/momsdeklaration/v1',
      'https://api.skatteverket.se/momsdeklaration/v1',
    ],
  },
  {
    service: 'skattekonto',
    envVar: 'SKATTEVERKET_SKATTEKONTO_API_BASE_URL',
    defaults: [
      'https://api.test.skatteverket.se/beskattning/skattekonto/v2',
      'https://api.skatteverket.se/beskattning/skattekonto/v2',
    ],
  },
  {
    service: 'agd-inlamning',
    envVar: 'SKATTEVERKET_AGD_INLAMNING_API_BASE_URL',
    defaults: [
      'https://api.test.skatteverket.se/arbetsgivardeklaration/inlamning/v1',
      'https://api.skatteverket.se/arbetsgivardeklaration/inlamning/v1',
    ],
  },
  {
    service: 'agd-period',
    envVar: 'SKATTEVERKET_AGD_PERIOD_API_BASE_URL',
    defaults: [
      'https://api.test.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1',
      'https://api.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1',
    ],
  },
]

/**
 * Map a per-service client's base URL to the proxy's service segment.
 * Throws on an unmapped base: silently proxying to the wrong backing API
 * would file against the wrong service, so this fails loudly instead.
 */
export function baseUrlToService(baseUrl: string): SkvConnectorService {
  const normalized = baseUrl.replace(/\/+$/, '')
  for (const { service, envVar, defaults } of SERVICE_BASES) {
    const envValue = process.env[envVar]?.replace(/\/+$/, '')
    if (envValue && envValue === normalized) return service
    if (defaults.includes(normalized)) return service
  }
  throw new Error(
    `Okänd Skatteverket-tjänst för connector-läget: ${baseUrl}. ` +
      'Bastjänsten måste vara en av moms, skattekonto, agd-inlamning, agd-period.',
  )
}

/** Read a broker error body's connector code, if the body carries one. */
export function parseConnectorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown }
    if (typeof parsed?.code === 'string' && parsed.code.startsWith('CONNECTOR_')) {
      return parsed.code
    }
  } catch {
    // Not JSON: an upstream SKV body passed through the proxy.
  }
  return null
}

export interface ConnectorAuthorizationStart {
  authorizeUrl: string
  /** The HOSTED redirect_uri registered at SKV; must be sent verbatim in the token exchange. */
  redirectUri: string
  /** The broker's signed state; required by the broker's token exchange. */
  connectorState: string
}

/**
 * Ask the broker to start a Skatteverket BankID consent. The broker signs a
 * connector state carrying returnUrl, so the hosted SKV callback bounces the
 * browser back to this instance with the code; the instance keeps its own
 * PKCE verifier and later exchanges through the broker.
 */
export async function startConnectorAuthorization(
  connector: ConnectorUpstream,
  args: {
    companyRef: string
    returnUrl: string
    state: string
    codeChallenge: string
    scope?: string
  },
): Promise<ConnectorAuthorizationStart> {
  const response = await fetchWithTimeout(
    `${connector.baseUrl}/oauth/authorize-url`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connector.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        company_ref: args.companyRef,
        return_url: args.returnUrl,
        state: args.state,
        code_challenge: args.codeChallenge,
        ...(args.scope ? { scope: args.scope } : {}),
      }),
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Connector authorize-url' },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Connector authorize-url failed (${response.status}): ${text}`)
  }
  const json = (await response.json()) as {
    data?: { authorize_url?: string; redirect_uri?: string; connector_state?: string }
  }
  const data = json?.data
  if (!data?.authorize_url || !data?.redirect_uri || !data?.connector_state) {
    throw new Error('Connector authorize-url: oväntat svar från brokern')
  }
  return {
    authorizeUrl: data.authorize_url,
    redirectUri: data.redirect_uri,
    connectorState: data.connector_state,
  }
}

/** The broker's /oauth/token payload (unwrapped from its { data } envelope). */
export interface ConnectorTokenData {
  access_token: string
  refresh_token?: string | null
  expires_in?: number
  scope?: string
}

async function connectorTokenRequest(
  connector: ConnectorUpstream,
  body: Record<string, string>,
  description: string,
  timeoutMs: number,
): Promise<ConnectorTokenData> {
  const response = await fetchWithTimeout(
    `${connector.baseUrl}/oauth/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connector.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    { timeoutMs, description },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    // The message carries status + body so api-client's dead-refresh-token
    // classifier can match the broker dialect (404 CONNECTOR_NOT_OWNED).
    throw new Error(`Skatteverket token ${description} failed (${response.status}): ${text}`)
  }
  const json = (await response.json()) as { data?: ConnectorTokenData }
  if (!json?.data?.access_token) {
    throw new Error(`Skatteverket token ${description}: oväntat svar från brokern`)
  }
  return json.data
}

/** Exchange an authorization code through the broker (grant authorization_code). */
export function exchangeConnectorCode(
  connector: ConnectorUpstream,
  args: { code: string; redirectUri: string; codeVerifier?: string; connectorState: string },
): Promise<ConnectorTokenData> {
  return connectorTokenRequest(
    connector,
    {
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirectUri,
      ...(args.codeVerifier ? { code_verifier: args.codeVerifier } : {}),
      connector_state: args.connectorState,
    },
    'exchange',
    SKATTEVERKET_EXCHANGE_TIMEOUT_MS,
  )
}

/** Refresh through the broker (grant refresh_token). */
export function refreshConnectorToken(
  connector: ConnectorUpstream,
  refreshToken: string,
): Promise<ConnectorTokenData> {
  return connectorTokenRequest(
    connector,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    'refresh',
    OAUTH_TIMEOUT_MS,
  )
}
