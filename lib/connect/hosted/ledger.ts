import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The connector connection ledger: proof, without secrets, that a connection
 * belongs to a given connector key. Every bank/SKV connection is born through
 * the proxy (the consent redirect is ours), so the proxy records it at
 * creation and checks ownership on every later use. The upstream handle (EB
 * session id, SKV access token) is hashed; the value never rests here.
 */

export type ConnectorService = 'bank' | 'skatteverket'

export function hashHandle(handle: string): string {
  return crypto.createHash('sha256').update(handle).digest('hex')
}

export interface LedgerRow {
  id: string
  connector_key_id: string
  service: ConnectorService
  company_ref: string
  provider: string | null
  account_uids: string[]
  status: 'pending' | 'active' | 'revoked'
}

/** Active connections for one company under one key and service. Enforces the per-company limit. */
export async function countActiveConnections(
  supabase: SupabaseClient,
  keyId: string,
  service: ConnectorService,
  companyRef: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('connector_connections')
    .select('id', { count: 'exact', head: true })
    .eq('connector_key_id', keyId)
    .eq('service', service)
    .eq('company_ref', companyRef)
    .eq('status', 'active')
  if (error) throw new Error(`ledger count failed: ${error.message}`)
  return count ?? 0
}

/**
 * Pending rows count toward quota only while their consent window is open:
 * the signed connector state expires after 15 minutes, so an abandoned
 * consent stops reserving capacity once its state can no longer activate it.
 */
export const PENDING_QUOTA_WINDOW_MS = 15 * 60 * 1000

/**
 * Rows currently holding or reserving quota for (key, service, company):
 * active connections plus fresh pending reservations. Used by the /auth
 * quota check both before insert (fast reject) and after insert (the
 * reservation re-count that closes the concurrent-auth race).
 */
export async function countHeldConnections(
  supabase: SupabaseClient,
  keyId: string,
  service: ConnectorService,
  companyRef: string,
  now: Date = new Date(),
): Promise<number> {
  const freshPendingSince = new Date(now.getTime() - PENDING_QUOTA_WINDOW_MS).toISOString()
  const { count, error } = await supabase
    .from('connector_connections')
    .select('id', { count: 'exact', head: true })
    .eq('connector_key_id', keyId)
    .eq('service', service)
    .eq('company_ref', companyRef)
    .or(`status.eq.active,and(status.eq.pending,created_at.gte.${freshPendingSince})`)
  if (error) throw new Error(`ledger count failed: ${error.message}`)
  return count ?? 0
}

/** Roll back a just-created pending reservation (lost the quota re-count). */
export async function deletePendingConnectionById(supabase: SupabaseClient, id: string): Promise<void> {
  await supabase.from('connector_connections').delete().eq('id', id).eq('status', 'pending')
}

export async function createPendingConnection(
  supabase: SupabaseClient,
  params: { keyId: string; service: ConnectorService; companyRef: string; provider: string | null; pendingState: string },
): Promise<string> {
  const { data, error } = await supabase
    .from('connector_connections')
    .insert({
      connector_key_id: params.keyId,
      service: params.service,
      company_ref: params.companyRef,
      provider: params.provider,
      pending_state: params.pendingState,
      status: 'pending',
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`ledger insert failed: ${error?.message}`)
  return (data as { id: string }).id
}

/**
 * The pending row a signed state belongs to, under the presenting key.
 * Precondition for the code exchange at POST /sessions: exchanging a code
 * against a state with no pending row would mint an upstream session the
 * ledger never records (and cross-flow substitution could smuggle a code
 * into a foreign state). The state's own TTL bounds freshness.
 */
export async function findPendingByState(
  supabase: SupabaseClient,
  params: { keyId: string; pendingState: string },
): Promise<LedgerRow | null> {
  const { data, error } = await supabase
    .from('connector_connections')
    .select('id, connector_key_id, service, company_ref, provider, account_uids, status')
    .eq('connector_key_id', params.keyId)
    .eq('pending_state', params.pendingState)
    .eq('status', 'pending')
    .maybeSingle()
  if (error) throw new Error(`ledger pending lookup failed: ${error.message}`)
  return (data as LedgerRow | null) ?? null
}

/**
 * The ACTIVE row whose refresh-token hash matches, under the presenting key.
 * Ownership precondition for the SKV refresh exchange: without it the broker
 * was an open refresh oracle for any leaked refresh token.
 */
export async function findByRefreshHash(
  supabase: SupabaseClient,
  params: { keyId: string; refreshHash: string },
): Promise<LedgerRow | null> {
  const { data, error } = await supabase
    .from('connector_connections')
    .select('id, connector_key_id, service, company_ref, provider, account_uids, status')
    .eq('connector_key_id', params.keyId)
    .eq('service', 'skatteverket')
    .eq('refresh_hash', params.refreshHash)
    .eq('status', 'active')
    .maybeSingle()
  if (error) throw new Error(`ledger refresh lookup failed: ${error.message}`)
  return (data as LedgerRow | null) ?? null
}

/** Activate a pending connection (found by its signed pending_state) with the live handle + accounts. */
export async function activateByPendingState(
  supabase: SupabaseClient,
  params: { keyId: string; pendingState: string; handle: string; accountUids?: string[] },
): Promise<LedgerRow | null> {
  const { data, error } = await supabase
    .from('connector_connections')
    .update({
      status: 'active',
      handle_hash: hashHandle(params.handle),
      account_uids: params.accountUids ?? [],
      pending_state: null,
      activated_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    })
    .eq('connector_key_id', params.keyId)
    .eq('pending_state', params.pendingState)
    .eq('status', 'pending')
    .select('id, connector_key_id, service, company_ref, provider, account_uids, status')
    .maybeSingle()
  if (error) throw new Error(`ledger activate failed: ${error.message}`)
  return (data as LedgerRow | null) ?? null
}

/** The active ledger row that owns a given handle under a key. Ownership check for reads/writes. */
export async function findByHandle(
  supabase: SupabaseClient,
  params: { keyId: string; service: ConnectorService; handle: string },
): Promise<LedgerRow | null> {
  const { data, error } = await supabase
    .from('connector_connections')
    .select('id, connector_key_id, service, company_ref, provider, account_uids, status')
    .eq('connector_key_id', params.keyId)
    .eq('service', params.service)
    .eq('handle_hash', hashHandle(params.handle))
    .eq('status', 'active')
    .maybeSingle()
  if (error) throw new Error(`ledger lookup failed: ${error.message}`)
  return (data as LedgerRow | null) ?? null
}

/** The active ledger row that owns a bank account uid under a key. */
export async function findByAccountUid(
  supabase: SupabaseClient,
  params: { keyId: string; accountUid: string },
): Promise<LedgerRow | null> {
  const { data, error } = await supabase
    .from('connector_connections')
    .select('id, connector_key_id, service, company_ref, provider, account_uids, status')
    .eq('connector_key_id', params.keyId)
    .eq('service', 'bank')
    .eq('status', 'active')
    .contains('account_uids', [params.accountUid])
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`ledger account lookup failed: ${error.message}`)
  return (data as LedgerRow | null) ?? null
}

export async function touchConnection(supabase: SupabaseClient, id: string): Promise<void> {
  await supabase.from('connector_connections').update({ last_used_at: new Date().toISOString() }).eq('id', id)
}

/** Revoke by handle (DELETE /sessions). Idempotent. */
export async function revokeByHandle(
  supabase: SupabaseClient,
  params: { keyId: string; service: ConnectorService; handle: string },
): Promise<void> {
  await supabase
    .from('connector_connections')
    .update({ status: 'revoked', revoked_at: new Date().toISOString() })
    .eq('connector_key_id', params.keyId)
    .eq('service', params.service)
    .eq('handle_hash', hashHandle(params.handle))
    .eq('status', 'active')
}
