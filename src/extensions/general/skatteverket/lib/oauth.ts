import type { SkatteverketTokens } from '../types'
import {
  buildSkvAuthorizeUrl,
  exchangeSkvCode,
  generatePkcePair,
  refreshSkvToken,
  skvDefaultScopes,
} from '@/lib/connect/upstreams/skatteverket-oauth'
import {
  skatteverketConnectorMode,
  exchangeConnectorCode,
  refreshConnectorToken,
} from './connector-mode'

/**
 * Skatteverket OAuth2 helpers for the `per` (BankID) flow.
 *
 * Endpoints:
 *   Authorize: GET  {base}/authorize
 *   Token:     POST {base}/token
 *
 * The `per` flow is user-facing BankID authentication.
 * No mTLS required (unlike the `org` flow).
 *
 * Connector mode (self-host with GNUBOK_CONNECTOR_KEY and no own SKV
 * credentials): the token functions route through the hosted broker's
 * /api/connect/skv/oauth/token instead; client_id/client_secret never leave
 * the instance because the instance never has them (the broker holds Arcim's
 * registered client). buildAuthorizeUrl stays direct-only: connector-mode
 * authorization starts via startConnectorAuthorization (connector-mode.ts),
 * which returns the broker-built URL plus the connector state and hosted
 * redirect_uri the caller must persist for the exchange.
 *
 * The direct path runs on the core helpers in
 * lib/connect/upstreams/skatteverket-oauth.ts, the same code the hosted
 * broker uses: one scope set (documented there), an https-only base URL and
 * redirect 'error' on the token POST, which carries Arcim's client_secret.
 */

export { generatePkcePair }

/**
 * Build the Skatteverket OAuth2 authorization URL.
 * User is redirected here to authenticate with BankID.
 */
export function buildAuthorizeUrl(
  redirectUri: string,
  state: string,
  options?: { scope?: string; codeChallenge?: string }
): string {
  return buildSkvAuthorizeUrl(redirectUri, state, options)
}

/**
 * Exchange an authorization code for tokens.
 * Must be called immediately upon receiving the callback: code expires in 5 minutes.
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  codeVerifier?: string,
  connectorState?: string,
): Promise<SkatteverketTokens> {
  const connector = skatteverketConnectorMode()
  if (connector) {
    if (!connectorState) {
      // A flow started before connector mode was enabled (or a state row that
      // lost its connector_state) cannot be exchanged through the broker.
      throw new Error(
        'connector_state saknas: anslutningsflödet startades inte via connectorn. Starta om anslutningen.',
      )
    }
    const data = await exchangeConnectorCode(connector, {
      code,
      redirectUri,
      codeVerifier,
      connectorState,
    })
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? null,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      refresh_count: 0,
      scope: data.scope ?? skvDefaultScopes(),
    }
  }

  const data = await exchangeSkvCode(code, redirectUri, codeVerifier)
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    refresh_count: 0,
    scope: data.scope,
  }
}

/**
 * Refresh an access token using a stored refresh token.
 *
 * The `per` flow supports up to 10 refreshes per session.
 * Each refresh returns a NEW refresh_token that must be stored.
 * Refresh tokens are valid for 65 minutes.
 */
export async function refreshAccessToken(
  refreshToken: string,
  previousRefreshCount: number
): Promise<SkatteverketTokens> {
  const connector = skatteverketConnectorMode()
  if (connector) {
    // Broker refresh rotates the hosted ledger's token hashes. Terminal
    // failures come back as broker dialects api-client classifies as
    // SESSION_EXPIRED: 401 CONNECTOR_SKV_REFRESH_DEAD (SKV declared the
    // refresh token dead: the dominant outcome, per-flow tokens live 65
    // minutes) and 404 CONNECTOR_NOT_OWNED (the ledger no longer vouches for
    // it). The generic 502 stays a raw error (transient SKV outage must not
    // flag the row for reconnect, the #1155 lesson).
    const data = await refreshConnectorToken(connector, refreshToken)
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? null,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      refresh_count: previousRefreshCount + 1,
      scope: data.scope ?? '',
    }
  }

  const data = await refreshSkvToken(refreshToken)
  return {
    access_token: data.access_token,
    // Each refresh returns a new refresh_token: must be stored
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    refresh_count: previousRefreshCount + 1,
    scope: data.scope,
  }
}
