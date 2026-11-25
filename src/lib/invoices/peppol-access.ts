/**
 * Peppol access per company: locked by default, requested by the company,
 * switched on (with a monthly sending cap, and receiving when the company
 * chose it) by the plan rule in lib/invoices/peppol-plan-rule.ts as soon as
 * the company pays. Operators can still grant, adjust or disable a row by
 * hand (scripts/peppol/access.ts).
 *
 * Why a gate at all: every transmission through the Access Point is billed
 * per document and every receiving identifier consumes a contracted tenant
 * slot, so "anyone can toggle it on" is a cost and a contract exposure, not a
 * feature. The gate is also the product truth on the invoice page: the send
 * action says "ask for access" instead of pretending.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { stockholmWallTimeToUtc, todayIsoStockholm } from '@/lib/dates/iso'

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

/**
 * What the product shows and gates on. `max_sends` caps transmissions per
 * calendar month in Europe/Stockholm; `sent_count` counts this month's real
 * transmissions, so the cap resets on the 1st.
 */
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

/** The first instant of the current calendar month in Europe/Stockholm, as ISO. */
export function peppolSendPeriodStart(now: Date = new Date()): string {
  return stockholmWallTimeToUtc(`${todayIsoStockholm(now).slice(0, 8)}01`, '00:00').toISOString()
}

/**
 * Why a count failed. A count is a HEAD request, so a refusal (a JWT that
 * reaches no row, crm#1641) arrives without a body and its message is empty:
 * the code and the HTTP status still say what happened.
 */
function countFailure(result: { error: { message?: string; code?: string }; status?: number }): string {
  return result.error.message || result.error.code || `HTTP ${result.status ?? 'unknown'}`
}

/**
 * Transmissions actually handed to the access point (a provider submission id
 * exists) this calendar month. `submitted_at` is set when the access point
 * accepts the document; a row without it falls back to when it was created.
 * Read with a service-role client: peppol_deliveries is not granted to
 * authenticated.
 */
export async function countPeppolSends(
  service: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<number> {
  const since = peppolSendPeriodStart(now)
  const submitted = await service
    .from('peppol_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .not('provider_submission_id', 'is', null)
    .gte('submitted_at', since)
  if (submitted.error) throw new Error(`Failed to count Peppol sends: ${countFailure(submitted)}`)
  const unstamped = await service
    .from('peppol_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .not('provider_submission_id', 'is', null)
    .is('submitted_at', null)
    .gte('created_at', since)
  if (unstamped.error) throw new Error(`Failed to count Peppol sends: ${countFailure(unstamped)}`)
  return (submitted.count ?? 0) + (unstamped.count ?? 0)
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

/** Receiving is on once the identifier is published at the access point, or while it is being published. */
export function peppolReceivingOn(registrationStatus: string | null | undefined): boolean {
  return registrationStatus === 'registered' || registrationStatus === 'pending'
}

/**
 * The company's Peppol connection in one word, read by the Peppol page and the
 * Kopplingar row alike: receiving (identifier published), sending (access
 * granted, nothing published) or off. The row once read only the
 * registration, so send-only access showed Inte kopplad.
 */
export function peppolConnectionState(
  access: Pick<PeppolAccessSummary, 'send_enabled'> | null | undefined,
  registrationStatus: string | null | undefined,
): 'receiving' | 'sending' | 'off' {
  if (peppolReceivingOn(registrationStatus)) return 'receiving'
  return access?.send_enabled ? 'sending' : 'off'
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
  | { ok: false; code: 'PEPPOL_ACCESS_ALREADY_ENABLED' | 'PEPPOL_ACCESS_DISABLED' }

/**
 * A company asks for access. Idempotent: a second request keeps the first
 * timestamp and choice (`created` false); a company that already has access
 * is told so. `wantsReceiving` is the company's own choice, kept on the row;
 * it takes effect when access is switched on.
 *
 * A row the operators disabled stays disabled: a request would be switched
 * on at once by the plan rule, so asking again goes through support. A plan
 * that ended is not `disabled`; it leaves the row `requested`.
 */
export async function requestPeppolAccess(args: {
  service: SupabaseClient
  companyId: string
  userId: string
  note: string | null
  wantsReceiving: boolean
}): Promise<RequestPeppolAccessResult> {
  const existing = await getPeppolAccess(args.service, args.companyId)
  if (existing?.status === 'enabled') return { ok: false, code: 'PEPPOL_ACCESS_ALREADY_ENABLED' }
  if (existing?.status === 'disabled') return { ok: false, code: 'PEPPOL_ACCESS_DISABLED' }
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
      receive_enabled: args.wantsReceiving,
    }, { onConflict: 'company_id' })
    .select('*')
    .single()
  if (error || !data) throw new Error(`Failed to request Peppol access: ${error?.message ?? 'no row'}`)
  return { ok: true, row: data as PeppolAccessRow, created: true }
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
