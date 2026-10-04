import type { PosProvider, PosVenue } from '@accounted/connect-contract'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isStandardBASAccount } from '@/lib/bookkeeping/bas-reference'
import { todayIsoStockholm, addDaysIso } from '@/lib/dates/iso'
import { isSaneDateString } from '@/lib/invariants'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import {
  PosConnectError,
  connectPosVenue as connectVenueAtConnect,
  disconnectPosConnection as disconnectAtConnect,
  isPosConnectConfigured,
  listPosVenues,
  type PosConnectDeps,
} from './connect-client'
import { buildPosDayEntry, evaluatePosDay, posDayDescription, type PosReviewReason } from './evaluate'
import {
  applyPosSalesSettingsPatch,
  posSalesSettingsPatchSchema,
  resolvePosSalesSettings,
  type PosSalesSettings,
  type PosSalesSettingsPatch,
} from './settings'
import { reevaluatePosDays, syncPosConnection, type PosSyncResult } from './sync'
import {
  normalizeDaySummary,
  type PosConnectionRow,
  type PosConnectionServerRow,
  type PosSalesDayRow,
  type PosSalesDaySummaryRow,
} from './types'

/**
 * The POS sales capability as service functions, shared by the dashboard's
 * session routes and the operations (v1 REST, MCP, staged approvals), so the
 * doors cannot drift apart. Members read the tables; every write here goes
 * through the service role after the caller's door authorised the user.
 */

/** Test seam for the Connect transport. */
let connectDeps: PosConnectDeps = {}
export function setPosConnectDepsForTesting(deps: PosConnectDeps): void {
  connectDeps = deps
}

function admin() {
  return createServiceClientNoCookies()
}

export interface PosConnectionView extends PosConnectionRow {
  /** The stored settings merged over the defaults. */
  resolved_settings: PosSalesSettings
}

function view(row: PosConnectionRow): PosConnectionView {
  // Never hand the handle on, whatever the select returned.
  const { connection_handle: _handle, ...visible } = row as PosConnectionServerRow
  return { ...visible, resolved_settings: resolvePosSalesSettings(row.settings) }
}

function connectFailure(err: unknown): { ok: false; code: string; details?: Record<string, unknown> } {
  if (err instanceof PosConnectError) {
    return {
      ok: false,
      code: err.code === 'POS_CONNECT_UNCONFIGURED' ? 'POS_CONNECT_UNCONFIGURED' : 'POS_CONNECT_FAILED',
      details: { connect_code: err.code, retryable: err.retryable },
    }
  }
  throw err
}

async function companyOrgNumber(ctx: OperationContext): Promise<string | null> {
  const { data } = await ctx.supabase.from('company_settings').select('org_number').eq('company_id', ctx.companyId).maybeSingle()
  const digits = String((data as { org_number?: string | null } | null)?.org_number ?? '').replace(/\D/g, '')
  // A sole trader's organisation number is the personnummer: ten digits without the century.
  if (digits.length === 12) return digits.slice(2)
  return digits.length === 10 ? digits : null
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function listPosConnections(
  ctx: OperationContext,
  input: { include_ended?: boolean } = {},
): Promise<OperationOutcome<{ connections: PosConnectionView[]; available: boolean }>> {
  let query = ctx.supabase
    .from('pos_connections')
    .select(
      'id, company_id, provider, provider_name, route, venue_ref, venue_name, status, health, health_code, sync_from, synced_through, next_run_at, lease_until, last_success_at, last_error_code, last_error_at, failures_in_row, settings, created_by, created_at, ended_by, ended_at, updated_at',
    )
    .eq('company_id', ctx.companyId)
    .order('created_at', { ascending: false })
  if (!input.include_ended) query = query.neq('status', 'disconnected')
  const { data, error } = await query
  if (error) {
    ctx.log.error('pos connections read failed', error)
    return { ok: false, code: 'POS_READ_FAILED' }
  }
  return {
    ok: true,
    data: {
      connections: ((data ?? []) as unknown as PosConnectionRow[]).map(view),
      available: isPosConnectConfigured(connectDeps),
    },
  }
}

export async function listAvailablePosVenues(
  ctx: OperationContext,
): Promise<OperationOutcome<{ venues: PosVenue[]; providers: PosProvider[]; org_number: string }>> {
  const orgNumber = await companyOrgNumber(ctx)
  if (!orgNumber) return { ok: false, code: 'POS_ORG_NUMBER_MISSING' }
  try {
    const answer = await listPosVenues(ctx.companyId, orgNumber, connectDeps)
    return { ok: true, data: { venues: answer.venues, providers: answer.providers, org_number: orgNumber } }
  } catch (err) {
    return connectFailure(err)
  }
}

export interface ConnectPosVenueInput {
  provider: string
  venue_ref: string
  /** First business day to read; yesterday when left out. */
  sync_from?: string
}

export async function connectPosVenue(
  ctx: OperationContext,
  input: ConnectPosVenueInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ connection: PosConnectionView }>> {
  if (await isSandboxCompany(ctx.supabase, ctx.companyId)) return { ok: false, code: 'POS_SANDBOX_BLOCKED' }
  const orgNumber = await companyOrgNumber(ctx)
  if (!orgNumber) return { ok: false, code: 'POS_ORG_NUMBER_MISSING' }

  const today = todayIsoStockholm()
  const syncFrom = input.sync_from ?? addDaysIso(today, -1)
  if (!isSaneDateString(syncFrom) || syncFrom >= today) {
    return { ok: false, code: 'POS_SYNC_FROM_INVALID', details: { sync_from: syncFrom } }
  }

  const { data: existing } = await ctx.supabase
    .from('pos_connections')
    .select('id')
    .eq('company_id', ctx.companyId)
    .eq('provider', input.provider)
    .eq('venue_ref', input.venue_ref)
    .neq('status', 'disconnected')
    .maybeSingle()
  if (existing) return { ok: false, code: 'POS_ALREADY_CONNECTED', details: { connection_id: (existing as { id: string }).id } }

  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { provider: input.provider, venue_ref: input.venue_ref, sync_from: syncFrom } }
  }

  let connection
  try {
    connection = await connectVenueAtConnect(
      ctx.companyId,
      { provider: input.provider, venueRef: input.venue_ref, orgNumber },
      connectDeps,
    )
  } catch (err) {
    return connectFailure(err)
  }

  const { data, error } = await admin()
    .from('pos_connections')
    .insert({
      company_id: ctx.companyId,
      provider: connection.provider.ref,
      provider_name: connection.provider.displayName,
      venue_ref: connection.venueRef,
      venue_name: connection.venueName,
      connection_handle: connection.connectionHandle,
      status: 'active',
      health: 'ok',
      sync_from: syncFrom,
      next_run_at: new Date().toISOString(),
      created_by: ctx.userId,
    })
    .select(
      'id, company_id, provider, provider_name, route, venue_ref, venue_name, status, health, health_code, sync_from, synced_through, next_run_at, lease_until, last_success_at, last_error_code, last_error_at, failures_in_row, settings, created_by, created_at, ended_by, ended_at, updated_at',
    )
    .single()
  if (error || !data) {
    ctx.log.error('pos connection insert failed', error ?? new Error('no row'), { provider: input.provider })
    // Release the claim at Connect so a retry does not find the venue held by a row that does not exist.
    try {
      await disconnectAtConnect(ctx.companyId, connection.connectionHandle, connectDeps)
    } catch {
      // the retry rotates the handle anyway
    }
    return { ok: false, code: error?.code === '23505' ? 'POS_ALREADY_CONNECTED' : 'POS_CONNECT_FAILED' }
  }
  return { ok: true, created: true, data: { connection: view(data as unknown as PosConnectionRow) } }
}

/** The handle Connect gave, read with the service role: members never read it. */
async function connectionHandle(ctx: OperationContext, connectionId: string): Promise<string | null> {
  const { data } = await admin()
    .from('pos_connections')
    .select('connection_handle')
    .eq('id', connectionId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  return (data as unknown as PosConnectionServerRow | null)?.connection_handle ?? null
}

export async function disconnectPosConnection(
  ctx: OperationContext,
  input: { connection_id: string },
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ connection_id: string; status: 'disconnected' }>> {
  // Read through the caller's client: membership is proven by RLS, or by the
  // door for service-role callers.
  const { data: row } = await ctx.supabase
    .from('pos_connections')
    .select('id, status, venue_name, provider_name')
    .eq('id', input.connection_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  const connection = row as Pick<PosConnectionRow, 'id' | 'status' | 'venue_name' | 'provider_name'> | null
  if (!connection) return { ok: false, code: 'POS_CONNECTION_NOT_FOUND', details: { connection_id: input.connection_id } }
  if (connection.status === 'disconnected') {
    return options.dryRun
      ? { ok: true, dryRun: true, preview: { connection_id: connection.id, already_disconnected: true } }
      : { ok: true, data: { connection_id: connection.id, status: 'disconnected' } }
  }
  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { connection_id: connection.id, venue_name: connection.venue_name, provider_name: connection.provider_name } }
  }

  const warnings: OperationWarning[] = []
  const handle = await connectionHandle(ctx, connection.id)
  if (handle) {
    try {
      await disconnectAtConnect(ctx.companyId, handle, connectDeps)
    } catch (err) {
      // The local end stands either way: this ledger stops reading the venue.
      ctx.log.warn('pos disconnect at Connect failed; ending locally', {
        connectionId: connection.id,
        code: err instanceof PosConnectError ? err.code : 'unknown',
      })
      warnings.push({
        code: 'POS_DISCONNECT_REMOTE_FAILED',
        message_sv: 'Kopplingen är avslutad här, men Accounted Connect kunde inte nås. Ingen mer försäljning hämtas.',
        message_en: 'The connection is ended here, but Accounted Connect could not be reached. No more sales are fetched.',
      })
    }
  }
  const { error } = await admin()
    .from('pos_connections')
    .update({
      status: 'disconnected',
      connection_handle: null,
      ended_at: new Date().toISOString(),
      ended_by: ctx.userId,
      lease_until: new Date(0).toISOString(),
    })
    .eq('id', connection.id)
    .eq('company_id', ctx.companyId)
  if (error) {
    ctx.log.error('pos disconnect failed', error, { connectionId: connection.id })
    return { ok: false, code: 'POS_DISCONNECT_FAILED' }
  }
  return { ok: true, data: { connection_id: connection.id, status: 'disconnected' }, ...(warnings.length ? { warnings } : {}) }
}

/** Accounts the mapping names that are neither in the chart nor standard BAS (which the engine adds when used). */
async function unknownAccounts(ctx: OperationContext, settings: PosSalesSettings): Promise<string[]> {
  const named = [
    ...Object.values(settings.tender_accounts),
    ...Object.values(settings.revenue_accounts),
    ...Object.values(settings.vat_accounts),
    settings.tips_account,
    settings.rounding_account,
  ].filter((a): a is string => typeof a === 'string')
  const nonStandard = [...new Set(named)].filter((a) => !isStandardBASAccount(a))
  if (nonStandard.length === 0) return []
  const { data } = await ctx.supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', ctx.companyId)
    .eq('is_active', true)
    .in('account_number', nonStandard)
  const present = new Set(((data ?? []) as Array<{ account_number: string }>).map((r) => r.account_number))
  return nonStandard.filter((a) => !present.has(a))
}

export async function updatePosSalesSettings(
  ctx: OperationContext,
  input: { connection_id: string; settings: PosSalesSettingsPatch },
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ connection_id: string; settings: PosSalesSettings; reevaluated_days: number }>> {
  const patch = posSalesSettingsPatchSchema.safeParse(input.settings)
  if (!patch.success) return { ok: false, code: 'VALIDATION_ERROR', details: { issues: patch.error.issues.slice(0, 5) } }
  const { data: row } = await ctx.supabase
    .from('pos_connections')
    .select('id, settings, status')
    .eq('id', input.connection_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!row) return { ok: false, code: 'POS_CONNECTION_NOT_FOUND', details: { connection_id: input.connection_id } }
  const next = applyPosSalesSettingsPatch(resolvePosSalesSettings((row as { settings: unknown }).settings), patch.data)
  const unknown = await unknownAccounts(ctx, next)
  if (unknown.length > 0) return { ok: false, code: 'POS_SETTINGS_ACCOUNT_UNKNOWN', details: { accounts: unknown } }
  if (options.dryRun) return { ok: true, dryRun: true, preview: { connection_id: input.connection_id, settings: next } }

  const client = admin()
  const { error } = await client
    .from('pos_connections')
    .update({ settings: next })
    .eq('id', input.connection_id)
    .eq('company_id', ctx.companyId)
  if (error) {
    ctx.log.error('pos settings update failed', error, { connectionId: input.connection_id })
    return { ok: false, code: 'POS_SETTINGS_FAILED' }
  }
  const reevaluated = await reevaluatePosDays(client, input.connection_id, next)
  return { ok: true, data: { connection_id: input.connection_id, settings: next, reevaluated_days: reevaluated } }
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

export interface ListPosDaysInput {
  from?: string
  to?: string
  status?: PosSalesDaySummaryRow['status']
  connection_id?: string
  limit?: number
  offset?: number
}

export async function listPosSalesDays(
  ctx: OperationContext,
  input: ListPosDaysInput,
): Promise<OperationOutcome<{ days: PosSalesDaySummaryRow[]; total: number }>> {
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 200)
  const offset = Math.max(input.offset ?? 0, 0)
  let query = ctx.supabase
    .from('pos_sales_days')
    .select(
      'id, company_id, connection_id, business_date, currency, status, review_reasons, gross, net, vat, tips, receipt_count, tenders, vat_groups, raw_sha256, fetched_at, fetch_count, changed_after_booking, latest_raw_sha256, latest_fetched_at, journal_entry_id, booked_at, booked_by, created_at, updated_at',
      { count: 'exact' },
    )
    .eq('company_id', ctx.companyId)
    .order('business_date', { ascending: false })
    .range(offset, offset + limit - 1)
  if (input.from) query = query.gte('business_date', input.from)
  if (input.to) query = query.lte('business_date', input.to)
  if (input.status) query = query.eq('status', input.status)
  if (input.connection_id) query = query.eq('connection_id', input.connection_id)
  const { data, error, count } = await query
  if (error) {
    ctx.log.error('pos days read failed', error)
    return { ok: false, code: 'POS_READ_FAILED' }
  }
  return {
    ok: true,
    data: { days: ((data ?? []) as unknown as PosSalesDaySummaryRow[]).map(normalizeDaySummary), total: count ?? 0 },
  }
}

export interface PosDayDetail {
  day: PosSalesDayRow
  connection: Pick<PosConnectionRow, 'id' | 'provider' | 'provider_name' | 'venue_ref' | 'venue_name' | 'status'>
  description: string
  /** The voucher this day books as, or would book as; empty while something needs a person. */
  proposal: { lines: ReturnType<typeof buildPosDayEntry>['lines']; rounding_amount: number }
  reasons: PosReviewReason[]
  acknowledgeable: boolean
}

export async function getPosSalesDay(ctx: OperationContext, input: { day_id: string }): Promise<OperationOutcome<PosDayDetail>> {
  const { data: day } = await ctx.supabase
    .from('pos_sales_days')
    .select(
      'id, company_id, connection_id, business_date, currency, status, review_reasons, gross, net, vat, tips, receipt_count, tenders, vat_groups, raw_sha256, fetched_at, fetch_count, changed_after_booking, latest_raw_sha256, latest_fetched_at, journal_entry_id, booked_at, booked_by, created_at, updated_at, day',
    )
    .eq('id', input.day_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!day) return { ok: false, code: 'POS_DAY_NOT_FOUND', details: { day_id: input.day_id } }
  const row = normalizeDaySummary(day as unknown as PosSalesDayRow)
  const { data: connection } = await ctx.supabase
    .from('pos_connections')
    .select('id, provider, provider_name, venue_ref, venue_name, status, settings')
    .eq('id', row.connection_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!connection) return { ok: false, code: 'POS_DAY_NOT_FOUND', details: { day_id: input.day_id } }
  const conn = connection as unknown as PosConnectionRow
  const settings = resolvePosSalesSettings(conn.settings)
  const evaluation = row.journal_entry_id ? { reasons: [], acknowledgeable: false } : evaluatePosDay(row.day, settings)
  const entry = buildPosDayEntry(row.day, settings)
  return {
    ok: true,
    data: {
      day: row,
      connection: {
        id: conn.id,
        provider: conn.provider,
        provider_name: conn.provider_name,
        venue_ref: conn.venue_ref,
        venue_name: conn.venue_name,
        status: conn.status,
      },
      description: posDayDescription(row.day, conn.venue_name, conn.provider_name),
      proposal: { lines: entry.lines, rounding_amount: entry.roundingAmount },
      reasons: evaluation.reasons,
      acknowledgeable: evaluation.acknowledgeable,
    },
  }
}

export interface FetchPosDaysInput {
  connection_id?: string
  /** Closed business days to fetch now; the regular plan (missing days, then a refresh) when left out. */
  business_dates?: string[]
}

export async function fetchPosSalesDays(
  ctx: OperationContext,
  input: FetchPosDaysInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ results: PosSyncResult[] }>> {
  if (await isSandboxCompany(ctx.supabase, ctx.companyId)) return { ok: false, code: 'POS_SANDBOX_BLOCKED' }
  const badDates = (input.business_dates ?? []).filter((d) => !isSaneDateString(d))
  if (badDates.length > 0) return { ok: false, code: 'VALIDATION_ERROR', details: { business_dates: badDates } }
  let query = ctx.supabase.from('pos_connections').select('id').eq('company_id', ctx.companyId).eq('status', 'active')
  if (input.connection_id) query = query.eq('id', input.connection_id)
  const { data } = await query
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (ids.length === 0) return { ok: false, code: 'POS_CONNECTION_NOT_FOUND', details: { connection_id: input.connection_id ?? null } }
  if (options.dryRun) return { ok: true, dryRun: true, preview: { connection_ids: ids, business_dates: input.business_dates ?? null } }

  const client = admin()
  const results: PosSyncResult[] = []
  for (const id of ids) {
    results.push(
      await syncPosConnection(client, id, {
        log: ctx.log,
        ...(input.business_dates ? { dates: input.business_dates } : {}),
        connect: connectDeps,
      }),
    )
  }
  return { ok: true, data: { results } }
}
