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

export interface ValidatedConnectorKey {
  id: string
  orgNumber: string
  instanceUrl: string | null
  scopes: string[]
  status: ConnectorKeyStatus
  currentPeriodEnd: string | null
}

export type ConnectorKeyValidation =
  | { ok: true; key: ValidatedConnectorKey }
  | { ok: false; status: 401 | 403 | 429; code: 'CONNECTOR_KEY_INVALID' | 'CONNECTOR_KEY_SUSPENDED' | 'CONNECTOR_RATE_LIMITED'; error: string }

/**
 * Validate a presented key: format check, RPC lookup (atomic rate-limit
 * increment), status mapping. Never throws on a bad key; a database error
 * maps to 401 (fail closed) and is left to the caller's logger.
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
  if (error || !data || (Array.isArray(data) && data.length === 0)) {
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
    },
  }
}
