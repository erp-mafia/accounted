import { COLLECTIONS_BASE_PATH, DELIVERY_BASE_PATH } from '@accounted/connect-contract'
import { getConnectorConfig } from './config'
import {
  hasOwnEnableBankingCredentials,
  hasOwnPeppolCredentials,
  hasOwnSkatteverketCredentials,
} from '@/lib/entitlements/own-credentials'

/**
 * Instance-side connector routing: which upstream calls go through Accounted
 * Connect instead of to the provider directly.
 *
 * For bank sync, Skatteverket and Peppol, an upstream is in "connector mode"
 * when this installation has a connector key AND no own credentials for that
 * upstream. Hosted Accounted is an ordinary installation of Connect
 * (DECISIONS.md 2026-09-02): it moves upstream by upstream, so hosted is in
 * connector mode wherever it no longer holds the provider credentials itself
 * (the canary lists below move a few companies at a time before that). A
 * self-host that pastes GNUBOK_CONNECTOR_KEY and leaves
 * ENABLE_BANKING_PRIVATE_KEY / SKATTEVERKET_OAUTH2_CLIENT_ID unset gets routed
 * through Connect.
 *
 * Collections and delivery have no own-credentials form at all: the provider
 * code lives only in Connect, so a connector key is the only route
 * (collectionsConnectorMode, deliveryConnectorMode).
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
 * Company ids that use the connector for an upstream even though this
 * installation has its own credentials for it: the canary switch for moving
 * an installation upstream by upstream (hosted Accounted moves its bank sync
 * and its Skatteverket traffic to Connect a few companies at a time before
 * dropping its own keys). Comma-separated. Ignored without a connector key.
 */
type CanaryEnv = 'CONNECT_BANK_CANARY_COMPANIES' | 'CONNECT_SKV_CANARY_COMPANIES'

function canaryCompanies(envName: CanaryEnv): Set<string> {
  const raw = process.env[envName]?.trim()
  if (!raw) return new Set()
  return new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))
}

function isCanary(envName: CanaryEnv, companyId: string | undefined): boolean {
  return Boolean(companyId && canaryCompanies(envName).has(companyId))
}

export function bankConnectorMode(companyId?: string): ConnectorUpstream | null {
  const cfg = getConnectorConfig()
  if (!cfg) return null
  if (hasOwnEnableBankingCredentials() && !isCanary('CONNECT_BANK_CANARY_COMPANIES', companyId)) return null
  return { baseUrl: `${cfg.baseUrl}/api/connect/bank`, key: cfg.key }
}

/**
 * Skatteverket data calls for a company. Callers without a company (OAuth
 * start and token exchange, environment reporting) pass nothing and get the
 * plain rule: own credentials win. The canary applies to user-token data
 * reads and writes only, which is what carries a company id.
 */
export function skatteverketConnectorMode(companyId?: string): ConnectorUpstream | null {
  const cfg = getConnectorConfig()
  if (!cfg) return null
  if (hasOwnSkatteverketCredentials() && !isCanary('CONNECT_SKV_CANARY_COMPANIES', companyId)) return null
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

/**
 * Reminders, debt collection and payouts through the provider a company
 * activates (lib/collections). Connect is the only route: no installation
 * holds provider credentials for it, so there is no own-credentials branch.
 */
export function collectionsConnectorMode(): ConnectorUpstream | null {
  const cfg = getConnectorConfig()
  if (!cfg) return null
  return { baseUrl: `${cfg.baseUrl}${COLLECTIONS_BASE_PATH}`, key: cfg.key }
}

/** Invoice delivery by post, digital mailbox or e-invoice (lib/invoices/distribution). Connect only, like collections. */
export function deliveryConnectorMode(): ConnectorUpstream | null {
  const cfg = getConnectorConfig()
  if (!cfg) return null
  return { baseUrl: `${cfg.baseUrl}${DELIVERY_BASE_PATH}`, key: cfg.key }
}
