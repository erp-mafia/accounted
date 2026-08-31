/**
 * The wire contract between a self-hosted Accounted instance and the hosted
 * connector service (app.gnubok.se/api/connect/*). Shared by both sides so
 * the instance sync and the hosted endpoint cannot drift apart.
 *
 * Background: a self-hosted instance runs everything itself except the
 * services only Accounted can operate (bank sync via our PSD2/AISP
 * credentials, the Skatteverket API client, TIC org lookup, the migration
 * gateway). A connector key (`gnubok_ck_...`) is the subscription token for
 * those; this is the Nabu Casa model: everything local is free AGPL, the key
 * buys access to the hosted connectors, and enforcement is key auth at the
 * hosted proxy, never a licence check inside the instance.
 */

export const CONNECTOR_KEY_PREFIX = 'gnubok_ck_'

/** Header alternative to `Authorization: Bearer`, for proxied calls where Authorization carries an upstream token. */
export const CONNECTOR_KEY_HEADER = 'x-connector-key'

export const CONNECTOR_ENTITLEMENTS_PATH = '/api/connect/entitlements'

/** Default hosted origin. app.gnubok.se stays the machine-facing host for API traffic. */
export const DEFAULT_CONNECT_BASE_URL = 'https://app.gnubok.se'

export type ConnectorKeyStatus = 'active' | 'suspended' | 'revoked'

/** What the hosted service tells an instance about its key. */
export interface ConnectorEntitlements {
  status: ConnectorKeyStatus
  /** Capability keys the subscription covers (subset of CONNECTOR_CAPABILITIES). */
  scopes: string[]
  /** End of the paid period, ISO; null for an open-ended (manually issued) key. */
  current_period_end: string | null
  org_number: string
  /** The instance origin this key is pinned to; null until the first sync claims it. */
  instance_url: string | null
  server_time: string
}

/** What an instance reports on every sync (quantity billing input). */
export interface ConnectorSyncReport {
  active_company_count: number
  instance_url?: string
  app_version?: string
}
