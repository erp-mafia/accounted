import { getConnectorConfig } from './config'

/**
 * Instance-side connector routing for the bank and Skatteverket upstreams.
 *
 * An upstream is in "connector mode" when this instance has a connector key
 * AND no own credentials for that upstream. Hosted always has its own
 * credentials, so hosted is never in connector mode: the check is what keeps
 * hosted byte-identical. A self-host that pastes GNUBOK_CONNECTOR_KEY and
 * leaves ENABLE_BANKING_PRIVATE_KEY / SKATTEVERKET_OAUTH2_CLIENT_ID unset gets
 * routed through the hosted proxy instead.
 */

export const CONNECTOR_COMPANY_HEADER = 'X-Connector-Company'
export const CONNECTOR_UPSTREAM_AUTH_HEADER = 'X-Connector-Upstream-Authorization'
export const CONNECTOR_UPSTREAM_CONTENT_TYPE_HEADER = 'X-Connector-Upstream-Content-Type'

/** True when the instance would use its own Enable Banking credentials. */
export function hasOwnEnableBankingCredentials(): boolean {
  return !!(
    process.env.ENABLE_BANKING_PRIVATE_KEY_PRODUCTION ||
    process.env.ENABLE_BANKING_PRIVATE_KEY ||
    process.env.ENABLE_BANKING_APP_ID_PRODUCTION ||
    process.env.ENABLE_BANKING_APP_ID
  )
}

/** True when the instance would use its own Skatteverket OAuth client. */
export function hasOwnSkatteverketCredentials(): boolean {
  return !!(process.env.SKATTEVERKET_OAUTH2_CLIENT_ID || process.env.SKATTEVERKET_APIGW_CLIENT_ID)
}

export interface ConnectorUpstream {
  /** Base URL to send upstream requests to (the hosted proxy). */
  baseUrl: string
  /** The connector key, sent as Authorization: Bearer for proxy auth. */
  key: string
}

export function bankConnectorMode(): ConnectorUpstream | null {
  if (hasOwnEnableBankingCredentials()) return null
  const cfg = getConnectorConfig()
  if (!cfg) return null
  return { baseUrl: `${cfg.baseUrl}/api/connect/bank`, key: cfg.key }
}

export function skatteverketConnectorMode(): ConnectorUpstream | null {
  if (hasOwnSkatteverketCredentials()) return null
  const cfg = getConnectorConfig()
  if (!cfg) return null
  return { baseUrl: `${cfg.baseUrl}/api/connect/skv`, key: cfg.key }
}
