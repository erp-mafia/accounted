/**
 * digital_mailbox_connections: one row per company and provider, holding
 * both directions (migration 20261021140000_digital_mailboxes.sql).
 *
 * Every write here takes the service-role client: the table has no write
 * policy, and the routes that call these gate on the company admin first.
 * Reads that answer a member take their own client (RLS).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DigitalMailboxProviderId } from './types'

export type ReceiveState = 'off' | 'pending' | 'active' | 'ended'
export type SendState = 'off' | 'active' | 'ended'

/** The whole row: nothing secret is stored in it, so every read selects '*'. */
export interface DigitalMailboxConnection {
  id: string
  company_id: string
  provider: DigitalMailboxProviderId
  receive_state: ReceiveState
  account_ref: string | null
  mailbox_ref: string | null
  receive_since: string | null
  receive_connected_by: string | null
  receive_connected_at: string | null
  receive_ended_at: string | null
  last_synced_at: string | null
  send_state: SendState
  tenant_ref: string | null
  send_activated_by: string | null
  send_activated_at: string | null
  last_error: string | null
  last_error_at: string | null
  provider_meta: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** How far back a newly connected mailbox is read: invoices that came in just before the connection still need booking. */
export const RECEIVE_LOOKBACK_DAYS = 30

export function receiveSinceFrom(now: Date = new Date()): string {
  return new Date(now.getTime() - RECEIVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

export async function getConnection(
  supabase: SupabaseClient,
  companyId: string,
  provider: DigitalMailboxProviderId,
): Promise<DigitalMailboxConnection | null> {
  const { data, error } = await supabase
    .from('digital_mailbox_connections')
    .select('*')
    .eq('company_id', companyId)
    .eq('provider', provider)
    .maybeSingle()
  if (error) throw new Error(`digital mailbox connection read failed: ${error.message}`)
  return (data as DigitalMailboxConnection | null) ?? null
}

export async function listConnections(supabase: SupabaseClient, companyId: string): Promise<DigitalMailboxConnection[]> {
  const { data, error } = await supabase
    .from('digital_mailbox_connections')
    .select('*')
    .eq('company_id', companyId)
  if (error) throw new Error(`digital mailbox connections read failed: ${error.message}`)
  return (data as DigitalMailboxConnection[] | null) ?? []
}

export type ConnectionPatch = Partial<
  Omit<DigitalMailboxConnection, 'id' | 'company_id' | 'provider' | 'created_at' | 'updated_at'>
>

/** Create the company's row for the provider, or change it: one row per (company, provider). */
export async function upsertConnection(
  service: SupabaseClient,
  companyId: string,
  provider: DigitalMailboxProviderId,
  patch: ConnectionPatch,
): Promise<DigitalMailboxConnection> {
  const { data, error } = await service
    .from('digital_mailbox_connections')
    .upsert({ company_id: companyId, provider, ...patch }, { onConflict: 'company_id,provider' })
    .select('*')
    .single()
  if (error || !data) throw new Error(`digital mailbox connection write failed: ${error?.message ?? 'no row'}`)
  return data as DigitalMailboxConnection
}

export async function updateConnection(
  service: SupabaseClient,
  connection: Pick<DigitalMailboxConnection, 'id' | 'company_id'>,
  patch: ConnectionPatch,
): Promise<void> {
  const { error } = await service
    .from('digital_mailbox_connections')
    .update(patch)
    .eq('id', connection.id)
    .eq('company_id', connection.company_id)
  if (error) throw new Error(`digital mailbox connection update failed: ${error.message}`)
}

/** The rows the sync reads: receiving switched on or waiting for the provider's confirmation. */
export async function listReceivingConnections(
  service: SupabaseClient,
  provider?: DigitalMailboxProviderId,
): Promise<DigitalMailboxConnection[]> {
  let query = service
    .from('digital_mailbox_connections')
    .select('*')
    .in('receive_state', ['pending', 'active'])
    .order('last_synced_at', { ascending: true, nullsFirst: true })
  if (provider) query = query.eq('provider', provider)
  const { data, error } = await query
  if (error) throw new Error(`digital mailbox connections read failed: ${error.message}`)
  return (data as DigitalMailboxConnection[] | null) ?? []
}

/** The live receiving row for a provider account (Kivra company_key, Billo enrolment). */
export async function findReceivingConnection(
  service: SupabaseClient,
  provider: DigitalMailboxProviderId,
  ref: { accountRef?: string | null; mailboxRef?: string | null },
): Promise<DigitalMailboxConnection | null> {
  if (!ref.accountRef && !ref.mailboxRef) return null
  let query = service
    .from('digital_mailbox_connections')
    .select('*')
    .eq('provider', provider)
    .in('receive_state', ['pending', 'active'])
  if (ref.accountRef) query = query.eq('account_ref', ref.accountRef)
  if (ref.mailboxRef) query = query.eq('mailbox_ref', ref.mailboxRef)
  const { data, error } = await query.limit(1).maybeSingle()
  if (error) throw new Error(`digital mailbox connection lookup failed: ${error.message}`)
  return (data as DigitalMailboxConnection | null) ?? null
}

/** The error a person or operator reads on the connection, cut to the column's limit. */
export function connectionError(message: string): Pick<ConnectionPatch, 'last_error' | 'last_error_at'> {
  return { last_error: message.slice(0, 500), last_error_at: new Date().toISOString() }
}

/** What the dashboard shows: never the provider's keys. */
export interface ConnectionSummary {
  provider: DigitalMailboxProviderId
  receive_state: ReceiveState
  receive_connected_at: string | null
  last_synced_at: string | null
  send_state: SendState
  send_activated_at: string | null
  last_error: string | null
  last_error_at: string | null
  /** Billo: the postal address that scans to the mailbox, when Billo gave one. */
  postal_address: unknown
}

export function summariseConnection(row: DigitalMailboxConnection): ConnectionSummary {
  return {
    provider: row.provider,
    receive_state: row.receive_state,
    receive_connected_at: row.receive_connected_at,
    last_synced_at: row.last_synced_at,
    send_state: row.send_state,
    send_activated_at: row.send_activated_at,
    last_error: row.last_error,
    last_error_at: row.last_error_at,
    postal_address: row.provider_meta?.billo_address ?? null,
  }
}
