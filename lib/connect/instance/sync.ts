import type { SupabaseClient } from '@supabase/supabase-js'
import { CONNECTOR_CAPABILITIES } from '@/lib/entitlements/keys'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  CONNECTOR_ENTITLEMENTS_PATH,
  type ConnectorEntitlements,
  type ConnectorSyncReport,
} from '../contract'
import { getConnectorConfig, type ConnectorConfig } from './config'

const log = createLogger('connector-sync')

/**
 * Grant rows ARE the offline cache. Each sync re-stamps the connector grants
 * to expire at min(now + 72h, period_end + 3d): the hosted service only has
 * to be reachable once in three days, and a lapsed subscription freezes the
 * connector capabilities within days even if the sync keeps running. Uses
 * the existing expiry check in lib/entitlements, zero new cache code.
 */
export const CONNECTOR_GRANT_TTL_MS = 72 * 60 * 60 * 1000
export const CONNECTOR_PERIOD_GRACE_MS = 3 * 24 * 60 * 60 * 1000
const UPSERT_CHUNK = 500

export type ConnectorSyncOutcome =
  | 'not_configured'
  | 'synced'
  | 'revoked'
  | 'network_error'
  | 'server_error'

export interface ConnectorSyncResult {
  outcome: ConnectorSyncOutcome
  companies: number
  grantsUpserted: number
  grantsDeleted: number
  status?: string
  httpStatus?: number
  scopes?: string[]
  expiresAt?: string
  message?: string
}

export interface ConnectorSyncOptions {
  fetchImpl?: typeof fetch
  now?: Date
  config?: ConnectorConfig | null
  instanceUrl?: string | null
  appVersion?: string | null
}

export function connectorGrantExpiry(now: Date, currentPeriodEnd: string | null): string {
  const ttl = now.getTime() + CONNECTOR_GRANT_TTL_MS
  if (!currentPeriodEnd) return new Date(ttl).toISOString()
  const periodGrace = new Date(currentPeriodEnd).getTime() + CONNECTOR_PERIOD_GRACE_MS
  return new Date(Math.min(ttl, periodGrace)).toISOString()
}

async function deleteConnectorGrants(supabase: SupabaseClient, keepKeys: string[] | null): Promise<number> {
  let query = supabase.from('capability_grants').delete({ count: 'exact' }).eq('source', 'connector')
  if (keepKeys && keepKeys.length > 0) {
    query = query.not('capability_key', 'in', `(${keepKeys.join(',')})`)
  }
  const { error, count } = await query
  if (error) throw new Error(`Failed to delete connector grants: ${error.message}`)
  return count ?? 0
}

/**
 * One sync run: report the active company count to the hosted service, then
 * translate the answer into source='connector' capability grants for every
 * company on this instance.
 *
 *   200 active        -> upsert grants for scopes, drop grants for scopes no
 *                        longer covered                                   (synced)
 *   200 non-active    -> delete all connector grants (freeze-and-retain)  (revoked)
 *   401 / 403         -> delete all connector grants                      (revoked)
 *   network error,
 *   429, 5xx, other   -> leave grants alone, they expire on their own     (network_error / server_error)
 */
export async function syncConnectorEntitlements(
  supabase: SupabaseClient,
  options: ConnectorSyncOptions = {},
): Promise<ConnectorSyncResult> {
  const config = options.config === undefined ? getConnectorConfig() : options.config
  if (!config) return { outcome: 'not_configured', companies: 0, grantsUpserted: 0, grantsDeleted: 0 }

  const now = options.now ?? new Date()
  const fetchImpl = options.fetchImpl ?? fetch

  const companies = await fetchAllRows<{ id: string }>(({ from, to }) =>
    supabase
      .from('companies')
      .select('id')
      .is('archived_at', null)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const companyIds = companies.map((c) => c.id)

  const report: ConnectorSyncReport = {
    active_company_count: companyIds.length,
    ...(options.instanceUrl ? { instance_url: options.instanceUrl } : {}),
    ...(options.appVersion ? { app_version: options.appVersion } : {}),
  }

  let response: Response
  try {
    response = await fetchImpl(`${config.baseUrl}${CONNECTOR_ENTITLEMENTS_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(report),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('connector sync: hosted service unreachable, keeping existing grants', { message })
    return { outcome: 'network_error', companies: companyIds.length, grantsUpserted: 0, grantsDeleted: 0, message }
  }

  if (response.status === 401 || response.status === 403) {
    // Delete the grant cache ONLY on a genuine connector rejection, proven by
    // the hosted route's own JSON body code (with-connector-auth always sends
    // one). A bare-status 401/403 also comes from layers where the app never
    // ran: a Vercel WAF challenge page, edge deployment protection, an egress
    // proxy at the self-host. Trusting the status alone let any of those wipe
    // a paying instance's 72h offline grace within the hour: the same failure
    // class as the RPC-error-to-401 mapping, one layer up. Anything without a
    // known rejection code keeps the grants and expires naturally.
    let rejectionCode: string | null = null
    try {
      const body = (await response.clone().json()) as { code?: string }
      if (typeof body.code === 'string') rejectionCode = body.code
    } catch {
      // Non-JSON body (challenge/error page): not a connector rejection.
    }
    const isConnectorRejection =
      rejectionCode === 'CONNECTOR_KEY_MISSING' ||
      rejectionCode === 'CONNECTOR_KEY_INVALID' ||
      rejectionCode === 'CONNECTOR_KEY_SUSPENDED'
    if (isConnectorRejection) {
      const grantsDeleted = await deleteConnectorGrants(supabase, null)
      log.warn('connector sync: key rejected by hosted service, connector grants removed', {
        httpStatus: response.status,
        code: rejectionCode,
        grantsDeleted,
      })
      return { outcome: 'revoked', companies: companyIds.length, grantsUpserted: 0, grantsDeleted, httpStatus: response.status }
    }
    log.warn('connector sync: 401/403 without a connector rejection code (edge/proxy?), keeping existing grants', {
      httpStatus: response.status,
      code: rejectionCode,
    })
    return { outcome: 'server_error', companies: companyIds.length, grantsUpserted: 0, grantsDeleted: 0, httpStatus: response.status }
  }
  if (!response.ok) {
    log.warn('connector sync: hosted service error, keeping existing grants', { httpStatus: response.status })
    return { outcome: 'server_error', companies: companyIds.length, grantsUpserted: 0, grantsDeleted: 0, httpStatus: response.status }
  }

  let entitlements: ConnectorEntitlements
  try {
    const body = (await response.json()) as { data?: ConnectorEntitlements }
    if (!body.data || typeof body.data.status !== 'string' || !Array.isArray(body.data.scopes)) {
      throw new Error('unexpected entitlements payload')
    }
    entitlements = body.data
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('connector sync: unreadable entitlements payload, keeping existing grants', { message })
    return { outcome: 'server_error', companies: companyIds.length, grantsUpserted: 0, grantsDeleted: 0, httpStatus: response.status, message }
  }

  if (entitlements.status !== 'active') {
    const grantsDeleted = await deleteConnectorGrants(supabase, null)
    log.warn('connector sync: key not active, connector grants removed', { status: entitlements.status, grantsDeleted })
    return { outcome: 'revoked', companies: companyIds.length, grantsUpserted: 0, grantsDeleted, status: entitlements.status }
  }

  const scopes = entitlements.scopes.filter((s) => (CONNECTOR_CAPABILITIES as readonly string[]).includes(s))
  const expiresAt = connectorGrantExpiry(now, entitlements.current_period_end)

  let grantsUpserted = 0
  if (scopes.length > 0 && companyIds.length > 0) {
    const rows = companyIds.flatMap((companyId) =>
      scopes.map((capabilityKey) => ({
        company_id: companyId,
        team_id: null,
        capability_key: capabilityKey,
        source: 'connector',
        expires_at: expiresAt,
      })),
    )
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK)
      const { error } = await supabase
        .from('capability_grants')
        .upsert(chunk, { onConflict: 'company_id,team_id,capability_key,source' })
      if (error) throw new Error(`Failed to upsert connector grants: ${error.message}`)
      grantsUpserted += chunk.length
    }
  }
  // Scopes the subscription no longer covers (or none at all): drop them.
  const grantsDeleted = await deleteConnectorGrants(supabase, scopes.length > 0 ? scopes : null)

  log.info('connector sync complete', { companies: companyIds.length, scopes, grantsUpserted, grantsDeleted, expiresAt })
  return {
    outcome: 'synced',
    companies: companyIds.length,
    grantsUpserted,
    grantsDeleted,
    status: entitlements.status,
    scopes,
    expiresAt,
    httpStatus: response.status,
  }
}
