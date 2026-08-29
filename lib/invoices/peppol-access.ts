/**
 * Peppol access per company: locked by default, requested by the company,
 * granted (with a sending cap, and separately receiving) by the operators.
 *
 * Why a gate at all: every transmission through the Access Point is billed
 * per document and every receiving identifier consumes a contracted tenant
 * slot, so "anyone can toggle it on" is a cost and a contract exposure, not a
 * feature. The gate is also the product truth on the invoice page: the send
 * action says "ask for access" instead of pretending.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type PeppolAccessStatus = 'requested' | 'enabled' | 'disabled'

export interface PeppolAccessRow {
  company_id: string
  status: PeppolAccessStatus
  max_sends: number | null
  receive_enabled: boolean
  requested_at: string | null
  requested_by: string | null
  request_note: string | null
  enabled_at: string | null
  enabled_by: string | null
  disabled_at: string | null
  note: string | null
  created_at: string
  updated_at: string
}

/** What the product shows and gates on. `sent_count` counts real transmissions. */
export interface PeppolAccessSummary {
  status: PeppolAccessStatus | 'none'
  send_enabled: boolean
  receive_enabled: boolean
  max_sends: number | null
  sent_count: number
  remaining_sends: number | null
  requested_at: string | null
  enabled_at: string | null
}

export async function getPeppolAccess(
  supabase: SupabaseClient,
  companyId: string,
): Promise<PeppolAccessRow | null> {
  const { data, error } = await supabase
    .from('peppol_access')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to read Peppol access: ${error.message}`)
  return (data as PeppolAccessRow | null) ?? null
}

/** Transmissions actually handed to the access point (a provider submission id exists). */
export async function countPeppolSends(
  service: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { count, error } = await service
    .from('peppol_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .not('provider_submission_id', 'is', null)
  if (error) throw new Error(`Failed to count Peppol sends: ${error.message}`)
  return count ?? 0
}

export function summarizePeppolAccess(row: PeppolAccessRow | null, sentCount: number): PeppolAccessSummary {
  const enabled = row?.status === 'enabled'
  const maxSends = enabled ? row?.max_sends ?? null : null
  return {
    status: row?.status ?? 'none',
    send_enabled: enabled,
    receive_enabled: enabled && !!row?.receive_enabled,
    max_sends: maxSends,
    sent_count: sentCount,
    remaining_sends: maxSends === null ? null : Math.max(0, maxSends - sentCount),
    requested_at: row?.requested_at ?? null,
    enabled_at: row?.enabled_at ?? null,
  }
}

export async function getPeppolAccessSummary(args: {
  supabase: SupabaseClient
  service: SupabaseClient
  companyId: string
}): Promise<PeppolAccessSummary> {
  const row = await getPeppolAccess(args.supabase, args.companyId)
  const sent = row?.status === 'enabled' ? await countPeppolSends(args.service, args.companyId) : 0
  return summarizePeppolAccess(row, sent)
}

export type PeppolSendPermission =
  | { ok: true; remaining: number | null }
  | { ok: false; code: 'PEPPOL_ACCESS_REQUIRED' | 'PEPPOL_SEND_LIMIT_REACHED'; summary: PeppolAccessSummary }

/** The gate the send route asks before it touches the network. */
export async function checkPeppolSendPermission(args: {
  service: SupabaseClient
  companyId: string
}): Promise<PeppolSendPermission> {
  const row = await getPeppolAccess(args.service, args.companyId)
  if (!row || row.status !== 'enabled') {
    return { ok: false, code: 'PEPPOL_ACCESS_REQUIRED', summary: summarizePeppolAccess(row, 0) }
  }
  const sent = await countPeppolSends(args.service, args.companyId)
  const summary = summarizePeppolAccess(row, sent)
  if (summary.max_sends !== null && sent >= summary.max_sends) {
    return { ok: false, code: 'PEPPOL_SEND_LIMIT_REACHED', summary }
  }
  return { ok: true, remaining: summary.remaining_sends }
}

export type RequestPeppolAccessResult =
  | { ok: true; row: PeppolAccessRow; created: boolean }
  | { ok: false; code: 'PEPPOL_ACCESS_ALREADY_ENABLED' }

/**
 * A company asks for access. Idempotent: a second request keeps the first
 * timestamp; a company that already has access is told so. A disabled
 * company may ask again (the row goes back to `requested`).
 */
export async function requestPeppolAccess(args: {
  service: SupabaseClient
  companyId: string
  userId: string
  note: string | null
}): Promise<RequestPeppolAccessResult> {
  const existing = await getPeppolAccess(args.service, args.companyId)
  if (existing?.status === 'enabled') return { ok: false, code: 'PEPPOL_ACCESS_ALREADY_ENABLED' }
  if (existing?.status === 'requested') return { ok: true, row: existing, created: false }

  const now = new Date().toISOString()
  const { data, error } = await args.service
    .from('peppol_access')
    .upsert({
      company_id: args.companyId,
      status: 'requested',
      requested_at: now,
      requested_by: args.userId,
      request_note: args.note,
      disabled_at: null,
    }, { onConflict: 'company_id' })
    .select('*')
    .single()
  if (error || !data) throw new Error(`Failed to request Peppol access: ${error?.message ?? 'no row'}`)
  return { ok: true, row: data as PeppolAccessRow, created: !existing }
}

/** Operator action (service role): grant, adjust or withdraw access. */
export async function setPeppolAccess(args: {
  service: SupabaseClient
  companyId: string
  status: 'enabled' | 'disabled'
  maxSends?: number | null
  receiveEnabled?: boolean
  by: string
  note?: string | null
}): Promise<PeppolAccessRow> {
  const now = new Date().toISOString()
  const enabling = args.status === 'enabled'
  // Undefined values are dropped by JSON serialization, so an omitted option
  // leaves the stored column untouched on re-runs.
  const { data, error } = await args.service
    .from('peppol_access')
    .upsert({
      company_id: args.companyId,
      status: args.status,
      max_sends: args.maxSends,
      receive_enabled: args.receiveEnabled,
      note: args.note,
      enabled_at: enabling ? now : undefined,
      enabled_by: enabling ? args.by : undefined,
      disabled_at: enabling ? null : now,
    }, { onConflict: 'company_id' })
    .select('*')
    .single()
  if (error || !data) throw new Error(`Failed to set Peppol access: ${error?.message ?? 'no row'}`)
  return data as PeppolAccessRow
}
