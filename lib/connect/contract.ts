/**
 * The wire contract between a self-hosted Accounted instance and the hosted
 * connector service (connect.accounted.se/api/connect/*). The definitions live in
 * the MIT package packages/connect-contract (published as
 * @accounted/connect-contract) so that either side can be implemented outside
 * this repository; this module re-exports them for in-repo callers.
 *
 * Background: a self-hosted instance runs everything itself except the
 * services only Accounted can operate (bank sync via our PSD2/AISP
 * credentials, the Skatteverket API client, TIC org lookup, the migration
 * gateway). A connector key (`gnubok_ck_...`) is the subscription token for
 * those; this is the Nabu Casa model: everything local is free AGPL, the key
 * buys access to the hosted connectors, and enforcement is key auth at the
 * hosted proxy, never a licence check inside the instance.
 */

export {
  CONNECTOR_KEY_PREFIX,
  CONNECTOR_KEY_HEADER,
  CONNECTOR_ENTITLEMENTS_PATH,
  DEFAULT_CONNECT_BASE_URL,
  type ConnectorKeyStatus,
  type ConnectorEntitlements,
  type ConnectorSyncReport,
} from '@accounted/connect-contract'
