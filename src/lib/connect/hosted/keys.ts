import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { CONNECTOR_KEY_PREFIX, type ConnectorKeyStatus } from '../contract'

/**
 * Hosted-side connector key primitives. Mirrors lib/auth/api-keys.ts for
 * `gnubok_sk_` API keys: 32 CSPRNG bytes, SHA-256 at rest (the hash is the
 * lookup; a slow KDF adds nothing on a 256-bit random secret and would sit on
 * the hot path of every proxied request), atomic validate + rate-limit in a
 * SECURITY DEFINER RPC that only service_role may execute.
 */

export function generateConnectorKey(): { key: string; hash: string; prefix: string } {
  const random = crypto.randomBytes(32).toString('base64url')
  const key = `${CONNECTOR_KEY_PREFIX}${random}`
  return { key, hash: hashConnectorKey(key), prefix: key.slice(0, CONNECTOR_KEY_PREFIX.length + 8) }
}

export function hashConnectorKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

export function isConnectorKeyFormat(key: string): boolean {
  return key.startsWith(CONNECTOR_KEY_PREFIX) && key.length > CONNECTOR_KEY_PREFIX.length + 16
}

export interface ConnectorKeyLimits {
  bank_connections_per_company: number
  skv_connections_per_company: number
  /** Active Peppol receiving registrations per company ("one address"). */
  peppol_connections_per_company: number
  sync_min_interval_s: number
}

export const DEFAULT_CONNECTOR_LIMITS: ConnectorKeyLimits = {
  bank_connections_per_company: 1,
  skv_connections_per_company: 1,
  peppol_connections_per_company: 1,
  sync_min_interval_s: 0,
}

export interface ValidatedConnectorKey {
  id: string
  orgNumber: string
  instanceUrl: string | null
  scopes: string[]
  status: ConnectorKeyStatus
  currentPeriodEnd: string | null
  limits: ConnectorKeyLimits
}

export type ConnectorKeyValidation =
  | { ok: true; key: ValidatedConnectorKey }
  | { ok: false; status: 401 | 403 | 429; code: 'CONNECTOR_KEY_INVALID' | 'CONNECTOR_KEY_SUSPENDED' | 'CONNECTOR_RATE_LIMITED'; error: string }
  | { ok: false; status: 503; code: 'CONNECTOR_VALIDATION_UNAVAILABLE'; error: string }

/**
 * Validate a presented key: format check, RPC lookup (atomic rate-limit
 * increment), status mapping. Never throws on a bad key.
 *
 * A database/RPC error maps to 503, NEVER 401: the instance-side sync treats
 * 401/403 as key revocation and deletes its entire connector grant cache
 * (lib/connect/instance/sync.ts), so answering a hosted pooler blip with 401
 * would let a transient hosted incident destroy a paying instance's 72h
 * offline grace. 503 lands in the sync's keep-grants branch. Only a genuine
 * empty result (unknown or revoked key) is 401. This deliberately diverges
 * from the api-keys precedent, where a spurious 401 costs one request.
 */
export async function validateConnectorKey(
  key: string,
  supabase: SupabaseClient = createServiceClientNoCookies(),
): Promise<ConnectorKeyValidation> {
  if (!isConnectorKeyFormat(key)) {
    return { ok: false, status: 401, code: 'CONNECTOR_KEY_INVALID', error: 'Invalid connector key' }
  }
  const { data, error } = await supabase.rpc('validate_and_increment_connector_key', {
    p_key_hash: hashConnectorKey(key),
  })
  if (error) {
    return {
      ok: false,
      status: 503,
      code: 'CONNECTOR_VALIDATION_UNAVAILABLE',
      error: 'Connector key validation temporarily unavailable',
    }
  }
  if (!data || (Array.isArray(data) && data.length === 0)) {
    return { ok: false, status: 401, code: 'CONNECTOR_KEY_INVALID', error: 'Invalid connector key' }
  }
  const row = (Array.isArray(data) ? data[0] : data) as {
    connector_key_id: string
    org_number: string
    instance_url: string | null
    scopes: string[] | null
    status: string
    current_period_end: string | null
    rate_limited: boolean
    limits: Partial<ConnectorKeyLimits> | null
  }
  if (row.status !== 'active') {
    return { ok: false, status: 403, code: 'CONNECTOR_KEY_SUSPENDED', error: 'Connector key is suspended' }
  }
  if (row.rate_limited) {
    return { ok: false, status: 429, code: 'CONNECTOR_RATE_LIMITED', error: 'Rate limit exceeded' }
  }
  return {
    ok: true,
    key: {
      id: row.connector_key_id,
      orgNumber: row.org_number,
      instanceUrl: row.instance_url,
      scopes: row.scopes ?? [],
      status: 'active',
      currentPeriodEnd: row.current_period_end,
      limits: { ...DEFAULT_CONNECTOR_LIMITS, ...(row.limits ?? {}) },
    },
  }
}
