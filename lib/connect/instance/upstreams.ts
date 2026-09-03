import { getConnectorConfig } from './config'
import {
  hasOwnEnableBankingCredentials,
  hasOwnPeppolCredentials,
  hasOwnSkatteverketCredentials,
} from '@/lib/entitlements/own-credentials'

/**
 * Instance-side connector routing for the bank and Skatteverket upstreams.
 *
 * An upstream is in "connector mode" when this instance has a connector key
 * AND no own credentials for that upstream. Hosted always has its own
 * credentials, so hosted is never in connector mode: the check is what keeps
 * hosted byte-identical. A self-host that pastes GNUBOK_CONNECTOR_KEY and
 * leaves ENABLE_BANKING_PRIVATE_KEY / SKATTEVERKET_OAUTH2_CLIENT_ID unset gets
 * routed through the hosted proxy instead.
 *
 * The own-credentials checks live in lib/entitlements/own-credentials.ts:
 * they were forward-ported into the entitlement partition (PR #1747) so the
 * gate and this routing seam can never disagree about what "own credentials"
 * means. Re-exported here for the instance-side callers.
 */

export const CONNECTOR_COMPANY_HEADER = 'X-Connector-Company'
export const CONNECTOR_UPSTREAM_AUTH_HEADER = 'X-Connector-Upstream-Authorization'
export const CONNECTOR_UPSTREAM_CONTENT_TYPE_HEADER = 'X-Connector-Upstream-Content-Type'

export { hasOwnEnableBankingCredentials, hasOwnPeppolCredentials, hasOwnSkatteverketCredentials }

export interface ConnectorUpstream {
  /** Base URL to send upstream requests to (the hosted proxy). */
  baseUrl: string
  /** The connector key, sent as Authorization: Bearer for proxy auth. */
  key: string
}

/**
 * Company ids that use the connector for bank sync even though this
 * installation has its own Enable Banking credentials: the canary switch for
 * moving an installation upstream by upstream (hosted Accounted moves its
 * bank sync to Connect a few companies at a time before dropping its own
 * keys). Comma-separated. Ignored without a connector key.
 */
function bankCanaryCompanies(): Set<string> {
  const raw = process.env.CONNECT_BANK_CANARY_COMPANIES?.trim()
  if (!raw) return new Set()
  return new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))
}

export function bankConnectorMode(companyId?: string): ConnectorUpstream | null {
  const cfg = getConnectorConfig()
  if (!cfg) return null
  if (hasOwnEnableBankingCredentials() && !(companyId && bankCanaryCompanies().has(companyId))) return null
  return { baseUrl: `${cfg.baseUrl}/api/connect/bank`, key: cfg.key }
}

export function skatteverketConnectorMode(): ConnectorUpstream | null {
  if (hasOwnSkatteverketCredentials()) return null
  const cfg = getConnectorConfig()
  if (!cfg) return null
  return { baseUrl: `${cfg.baseUrl}/api/connect/skv`, key: cfg.key }
}

/**
 * Peppol through Arcim's contracted access point. Same rule as the other
 * upstreams: an instance with its own Qvalia partner keys runs Peppol itself
 * and is never routed here.
 */
export function peppolConnectorMode(): ConnectorUpstream | null {
  if (hasOwnPeppolCredentials()) return null
  const cfg = getConnectorConfig()
  if (!cfg) return null
  return { baseUrl: `${cfg.baseUrl}/api/connect/peppol`, key: cfg.key }
}
