import { createHash, randomBytes } from 'node:crypto'
import type { SpendProvider } from '@accounted/connect-contract'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { companyOrgNumber } from '@/lib/company/org-number'
import { orgNumberKey } from '@/lib/invariants/org-number'
import { getCanonicalAppOrigin } from '@/lib/domains/trusted-app-origin'
import type { Logger } from '@/lib/logger'
import { fetchChartVatTreatments } from '@/lib/bookkeeping/chart-vat-treatments'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import {
  SpendConnectError,
  authorizeSpend,
  completeSpendConnect as completeAtConnect,
  connectSpendWithKey as connectKeyAtConnect,
  disconnectSpendConnection as disconnectAtConnect,
  isSpendConnectConfigured,
  listSpendProviders,
  type SpendConnectDeps,
} from './connect-client'
import { buildSpendItemEntry, evaluateSpendExpense, spendItemDescription, type SpendReason } from './evaluate'
import { loadSpendCompanyContext } from './master-data'
import {
  applySpendSettingsPatch,
  resolveSpendSettings,
  spendSettingsPatchSchema,
  type SpendSettings,
  type SpendSettingsPatch,
} from './settings'
import { evaluationContextFor, loadBookableAccounts, reevaluateSpendItems, syncSpendConnection, type SpendSyncResult } from './sync'
import {
  SPEND_CONNECTION_COLUMNS,
  SPEND_ITEM_SUMMARY_COLUMNS,
  normalizeItemSummary,
  type SpendConnectionRow,
  type SpendConnectionServerRow,
  type SpendItemRow,
  type SpendItemSummaryRow,
} from './types'

/**
 * The spend capability as service functions, shared by the dashboard's
 * session routes and the operations (v1 REST, MCP, staged approvals), so the
 * doors cannot drift apart. Members read the tables; every write here goes
 * through the service role after the caller's door authorised the user.
 */

/** Test seam for the Connect transport. */
let connectDeps: SpendConnectDeps = {}
export function setSpendConnectDepsForTesting(deps: SpendConnectDeps): void {
  connectDeps = deps
}
export function spendConnectDeps(): SpendConnectDeps {
  return connectDeps
}

function admin() {
  return createServiceClientNoCookies()
}

/** How long a person has on the provider's consent page. */
const CONNECT_WINDOW_MS = 15 * 60 * 1000

export interface SpendConnectionView extends SpendConnectionRow {
  /** The stored settings merged over the defaults. */
  resolved_settings: SpendSettings
}

function view(row: SpendConnectionRow): SpendConnectionView {
  // Never hand on what only the server presents, whatever the select returned.
  const {
    connection_handle: _handle,
    pending_state_sha256: _state,
    pending_expires_at: _expires,
    pending_return_origin: _origin,
    ...visible
  } = row as SpendConnectionServerRow
  return { ...visible, resolved_settings: resolveSpendSettings(row.settings) }
}

function connectFailure(err: unknown): { ok: false; code: string; details?: Record<string, unknown> } {
  if (err instanceof SpendConnectError) {
    if (err.code === 'SPEND_CONNECT_UNCONFIGURED') return { ok: false, code: 'SPEND_CONNECT_UNCONFIGURED' }
    if (err.code === 'CONNECTOR_SPEND_COMPANY_MISMATCH') return { ok: false, code: 'SPEND_COMPANY_MISMATCH' }
    return { ok: false, code: 'SPEND_CONNECT_FAILED', details: { connect_code: err.code, retryable: err.retryable } }
  }
  throw err
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function listSpendConnections(
  ctx: OperationContext,
  input: { include_ended?: boolean } = {},
): Promise<OperationOutcome<{ connections: SpendConnectionView[]; available: boolean }>> {
  let query = ctx.supabase
    .from('spend_connections')
    .select(SPEND_CONNECTION_COLUMNS)
    .eq('company_id', ctx.companyId)
    .neq('status', 'connecting')
    .order('created_at', { ascending: false })
  if (!input.include_ended) query = query.neq('status', 'disconnected')
  const { data, error } = await query
  if (error) {
    ctx.log.error('spend connections read failed', error)
    return { ok: false, code: 'SPEND_READ_FAILED' }
  }
  return {
    ok: true,
    data: {
      connections: ((data ?? []) as unknown as SpendConnectionRow[]).map(view),
      available: isSpendConnectConfigured(connectDeps),
    },
  }
}

export async function listAvailableSpendProviders(ctx: OperationContext): Promise<OperationOutcome<{ providers: SpendProvider[] }>> {
  try {
    const answer = await listSpendProviders(ctx.companyId, connectDeps)
    return { ok: true, data: { providers: answer.providers } }
  } catch (err) {
    return connectFailure(err)
  }
}

async function liveConnection(ctx: OperationContext, provider: string): Promise<{ id: string; status: string } | null> {
  const { data } = await admin()
    .from('spend_connections')
    .select('id, status')
    .eq('company_id', ctx.companyId)
    .eq('provider', provider)
    .neq('status', 'disconnected')
    .maybeSingle()
  return (data as { id: string; status: string } | null) ?? null
}

export interface StartSpendConnectInput {
  provider: string
  /** The origin the person started on (the app or a brand domain), already validated by the route. */
  return_origin?: string | null
}

/**
 * Begin connecting through the provider's consent page: a pending row holds
 * the hash of a fresh state, and Connect answers with the consent URL. The
 * browser comes back to /api/spend/connections/return, which finishes with
 * completeSpendConnectReturn.
 */
export async function startSpendConnect(
  ctx: OperationContext,
  input: StartSpendConnectInput,
): Promise<OperationOutcome<{ connection_id: string; authorize_url: string }>> {
  if (await isSandboxCompany(ctx.supabase, ctx.companyId)) return { ok: false, code: 'SPEND_SANDBOX_BLOCKED' }
  const orgNumber = await companyOrgNumber(ctx.supabase, ctx.companyId)
  if (!orgNumber) return { ok: false, code: 'SPEND_ORG_NUMBER_MISSING' }

  let provider: SpendProvider | undefined
  try {
    provider = (await listSpendProviders(ctx.companyId, connectDeps)).providers.find((p) => p.ref === input.provider)
  } catch (err) {
    return connectFailure(err)
  }
  if (!provider) return { ok: false, code: 'SPEND_PROVIDER_UNKNOWN', details: { provider: input.provider } }
  if (!provider.connectModes.includes('oauth')) return { ok: false, code: 'SPEND_MODE_UNSUPPORTED', details: { mode: 'oauth' } }

  const existing = await liveConnection(ctx, provider.ref)
  if (existing && existing.status !== 'connecting') {
    return { ok: false, code: 'SPEND_ALREADY_CONNECTED', details: { connection_id: existing.id } }
  }

  const state = randomBytes(32).toString('base64url')
  const stateSha256 = sha256Hex(state)
  const expiresAt = new Date(Date.now() + CONNECT_WINDOW_MS).toISOString()
  const returnOrigin = input.return_origin ?? null
  const client = admin()
  // A started but unfinished attempt is replaced: only the newest state may
  // finish. Both payloads are written out so the schema guard checks them.
  const write = existing
    ? client
        .from('spend_connections')
        .update({
          provider_name: provider.displayName,
          mode: 'oauth',
          pending_state_sha256: stateSha256,
          pending_expires_at: expiresAt,
          pending_return_origin: returnOrigin,
          created_by: ctx.userId,
        })
        .eq('id', existing.id)
        .eq('status', 'connecting')
        .select('id')
        .single()
    : client
        .from('spend_connections')
        .insert({
          company_id: ctx.companyId,
          provider: provider.ref,
          provider_name: provider.displayName,
          mode: 'oauth',
          status: 'connecting',
          pending_state_sha256: stateSha256,
          pending_expires_at: expiresAt,
          pending_return_origin: returnOrigin,
          created_by: ctx.userId,
        })
        .select('id')
        .single()
  const { data, error } = await write
  if (error || !data) {
    ctx.log.error('spend pending connection write failed', error ?? new Error('no row'), { provider: provider.ref })
    return { ok: false, code: error?.code === '23505' ? 'SPEND_ALREADY_CONNECTED' : 'SPEND_CONNECT_FAILED' }
  }
  const connectionId = (data as { id: string }).id

  try {
    const answer = await authorizeSpend(
      ctx.companyId,
      { provider: provider.ref, orgNumber, returnUrl: `${getCanonicalAppOrigin()}/api/spend/connections/return`, state },
      connectDeps,
    )
    return { ok: true, data: { connection_id: connectionId, authorize_url: answer.authorizeUrl } }
  } catch (err) {
    await client.from('spend_connections').delete().eq('id', connectionId).eq('status', 'connecting')
    return connectFailure(err)
  }
}

/** The pending row a returning browser's state belongs to, read with the service role. */
export async function findPendingSpendConnection(state: string): Promise<SpendConnectionServerRow | null> {
  const { data } = await admin()
    .from('spend_connections')
    .select('id, company_id, provider, provider_name, status, created_by, pending_state_sha256, pending_expires_at, pending_return_origin')
    .eq('pending_state_sha256', sha256Hex(state))
    .eq('status', 'connecting')
    .maybeSingle()
  return (data as unknown as SpendConnectionServerRow | null) ?? null
}

export type CompleteSpendConnectOutcome =
  | { ok: true; connectionId: string; companyId: string }
  | { ok: false; code: 'SPEND_CONNECT_EXPIRED' | 'SPEND_COMPANY_MISMATCH' | 'SPEND_ALREADY_CONNECTED' | 'SPEND_CONNECT_FAILED' | 'SPEND_CONNECT_UNCONFIGURED' }

/**
 * Finish a consent round trip: Connect redeems the state and result for the
 * connection handle, and the pending row becomes the live connection. The
 * caller (the return route) has bound the browser to the person who started.
 */
export async function completeSpendConnectReturn(
  pending: SpendConnectionServerRow,
  input: { state: string; result: string },
  log: Logger,
): Promise<CompleteSpendConnectOutcome> {
  if (!pending.pending_expires_at || new Date(pending.pending_expires_at).getTime() < Date.now()) {
    return { ok: false, code: 'SPEND_CONNECT_EXPIRED' }
  }
  const client = admin()
  let connection
  try {
    connection = await completeAtConnect(pending.company_id, input, connectDeps)
  } catch (err) {
    if (err instanceof SpendConnectError) {
      log.warn('spend connect completion refused', { connectionId: pending.id, code: err.code })
      if (err.code === 'CONNECTOR_SPEND_COMPANY_MISMATCH') return { ok: false, code: 'SPEND_COMPANY_MISMATCH' }
      if (err.code === 'SPEND_CONNECT_UNCONFIGURED') return { ok: false, code: 'SPEND_CONNECT_UNCONFIGURED' }
      if (err.code === 'CONNECTOR_SPEND_ALREADY_CONNECTED') return { ok: false, code: 'SPEND_ALREADY_CONNECTED' }
      return { ok: false, code: 'SPEND_CONNECT_FAILED' }
    }
    throw err
  }

  // Connect refuses a provider company whose Swedish number is another
  // entity's; the same check here keeps a misbehaving service from mixing
  // two companies' spend in one ledger.
  // Compared as keys, so a 12-digit or hyphenated form of the same number is
  // the same company; a number that is not Swedish-shaped is not compared.
  const ours = orgNumberKey(await companyOrgNumber(client, pending.company_id))
  const theirs = orgNumberKey(connection.providerOrgNumber)
  if (ours && theirs && ours !== theirs) {
    try {
      await disconnectAtConnect(pending.company_id, connection.connectionHandle, connectDeps)
    } catch {
      // the pending row is ended either way
    }
    await client.from('spend_connections').delete().eq('id', pending.id).eq('status', 'connecting')
    return { ok: false, code: 'SPEND_COMPANY_MISMATCH' }
  }

  const { data, error } = await client
    .from('spend_connections')
    .update({
      status: 'active',
      provider_name: connection.provider.displayName,
      mode: connection.mode,
      connection_handle: connection.connectionHandle,
      provider_company_ref: connection.providerCompanyRef,
      provider_company_name: connection.providerCompanyName,
      provider_org_number: connection.providerOrgNumber,
      pending_state_sha256: null,
      pending_expires_at: null,
      pending_return_origin: null,
      health: 'ok',
      health_code: null,
      next_run_at: new Date().toISOString(),
    })
    .eq('id', pending.id)
    .eq('status', 'connecting')
    .eq('pending_state_sha256', sha256Hex(input.state))
    .select('id, company_id')
  if (error || !data || data.length === 0) {
    log.error('spend connection activation failed', error ?? new Error('state already used'), { connectionId: pending.id })
    return { ok: false, code: 'SPEND_CONNECT_FAILED' }
  }
  return { ok: true, connectionId: pending.id, companyId: pending.company_id }
}

/**
 * Connect with an API key the provider issued to the company (a provider
 * that offers keys, or a pilot before a partner client exists). The key goes
 * to Connect, which keeps it; nothing here stores it.
 */
export async function connectSpendWithApiKey(
  ctx: OperationContext,
  input: { provider: string; api_key: string },
): Promise<OperationOutcome<{ connection: SpendConnectionView }>> {
  if (await isSandboxCompany(ctx.supabase, ctx.companyId)) return { ok: false, code: 'SPEND_SANDBOX_BLOCKED' }
  const orgNumber = await companyOrgNumber(ctx.supabase, ctx.companyId)
  if (!orgNumber) return { ok: false, code: 'SPEND_ORG_NUMBER_MISSING' }
  const existing = await liveConnection(ctx, input.provider)
  if (existing && existing.status !== 'connecting') {
    return { ok: false, code: 'SPEND_ALREADY_CONNECTED', details: { connection_id: existing.id } }
  }

  let connection
  try {
    connection = await connectKeyAtConnect(ctx.companyId, { provider: input.provider, orgNumber, apiKey: input.api_key }, connectDeps)
  } catch (err) {
    return connectFailure(err)
  }
  const client = admin()
  if (existing) await client.from('spend_connections').delete().eq('id', existing.id).eq('status', 'connecting')
  const { data, error } = await client
    .from('spend_connections')
    .insert({
      company_id: ctx.companyId,
      provider: connection.provider.ref,
      provider_name: connection.provider.displayName,
      mode: connection.mode,
      connection_handle: connection.connectionHandle,
      provider_company_ref: connection.providerCompanyRef,
      provider_company_name: connection.providerCompanyName,
      provider_org_number: connection.providerOrgNumber,
      status: 'active',
      created_by: ctx.userId,
    })
    .select(SPEND_CONNECTION_COLUMNS)
    .single()
  if (error || !data) {
    ctx.log.error('spend connection insert failed', error ?? new Error('no row'), { provider: input.provider })
    try {
      await disconnectAtConnect(ctx.companyId, connection.connectionHandle, connectDeps)
    } catch {
      // the retry rotates the handle anyway
    }
    return { ok: false, code: error?.code === '23505' ? 'SPEND_ALREADY_CONNECTED' : 'SPEND_CONNECT_FAILED' }
  }
  return { ok: true, created: true, data: { connection: view(data as unknown as SpendConnectionRow) } }
}

/** The handle Connect gave, read with the service role: members never read it. */
async function connectionHandle(companyId: string, connectionId: string): Promise<string | null> {
  const { data } = await admin()
    .from('spend_connections')
    .select('connection_handle')
    .eq('id', connectionId)
    .eq('company_id', companyId)
    .maybeSingle()
  return (data as unknown as { connection_handle: string | null } | null)?.connection_handle ?? null
}

export async function disconnectSpendConnection(
  ctx: OperationContext,
  input: { connection_id: string },
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ connection_id: string; status: 'disconnected' }>> {
  // Read through the caller's client: membership is proven by RLS, or by the
  // door for service-role callers.
  const { data: row } = await ctx.supabase
    .from('spend_connections')
    .select('id, status, provider_name, provider_company_name')
    .eq('id', input.connection_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  const connection = row as Pick<SpendConnectionRow, 'id' | 'status' | 'provider_name' | 'provider_company_name'> | null
  if (!connection) return { ok: false, code: 'SPEND_CONNECTION_NOT_FOUND', details: { connection_id: input.connection_id } }
  if (connection.status === 'disconnected') {
    return options.dryRun
      ? { ok: true, dryRun: true, preview: { connection_id: connection.id, already_disconnected: true } }
      : { ok: true, data: { connection_id: connection.id, status: 'disconnected' } }
  }
  if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { connection_id: connection.id, provider_name: connection.provider_name, provider_company_name: connection.provider_company_name } }
  }

  const warnings: OperationWarning[] = []
  const handle = await connectionHandle(ctx.companyId, connection.id)
  if (handle) {
    try {
      await disconnectAtConnect(ctx.companyId, handle, connectDeps)
    } catch (err) {
      // The local end stands either way: this ledger stops receiving.
      ctx.log.warn('spend disconnect at Connect failed; ending locally', {
        connectionId: connection.id,
        code: err instanceof SpendConnectError ? err.code : 'unknown',
      })
      warnings.push({
        code: 'SPEND_DISCONNECT_REMOTE_FAILED',
        message_sv: 'Kopplingen är avslutad här, men Accounted Connect kunde inte nås. Inga fler utgifter tas emot.',
        message_en: 'The connection is ended here, but Accounted Connect could not be reached. No more expenses are received.',
      })
    }
  }
  const { error } = await admin()
    .from('spend_connections')
    .update({
      status: 'disconnected',
      connection_handle: null,
      pending_state_sha256: null,
      pending_expires_at: null,
      pending_return_origin: null,
      ended_at: new Date().toISOString(),
      ended_by: ctx.userId,
      lease_until: new Date(0).toISOString(),
    })
    .eq('id', connection.id)
    .eq('company_id', ctx.companyId)
  if (error) {
    ctx.log.error('spend disconnect failed', error, { connectionId: connection.id })
    return { ok: false, code: 'SPEND_DISCONNECT_FAILED' }
  }
  return { ok: true, data: { connection_id: connection.id, status: 'disconnected' }, ...(warnings.length ? { warnings } : {}) }
}

export async function updateSpendSettings(
  ctx: OperationContext,
  input: { connection_id: string; settings: SpendSettingsPatch },
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ connection_id: string; settings: SpendSettings; reevaluated_items: number }>> {
  const patch = spendSettingsPatchSchema.safeParse(input.settings)
  if (!patch.success) return { ok: false, code: 'VALIDATION_ERROR', details: { issues: patch.error.issues.slice(0, 5) } }
  const { data: row } = await ctx.supabase
    .from('spend_connections')
    .select('id, company_id, provider_name, settings, status')
    .eq('id', input.connection_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!row) return { ok: false, code: 'SPEND_CONNECTION_NOT_FOUND', details: { connection_id: input.connection_id } }
  const connection = row as Pick<SpendConnectionRow, 'id' | 'company_id' | 'provider_name' | 'settings' | 'status'>
  const next = applySpendSettingsPatch(resolveSpendSettings(connection.settings), patch.data)

  // The chart is the member's to read; only the write needs the server.
  const isBookable = await loadBookableAccounts(ctx.supabase, ctx.companyId)
  const unknown = [next.wallet_account, next.out_of_pocket_account].filter((a): a is string => typeof a === 'string' && !isBookable(a))
  if (unknown.length > 0) return { ok: false, code: 'SPEND_SETTINGS_ACCOUNT_UNKNOWN', details: { accounts: unknown } }
  if (options.dryRun) return { ok: true, dryRun: true, preview: { connection_id: input.connection_id, settings: next } }

  const client = admin()
  const { error } = await client
    .from('spend_connections')
    .update({ settings: next })
    .eq('id', input.connection_id)
    .eq('company_id', ctx.companyId)
  if (error) {
    ctx.log.error('spend settings update failed', error, { connectionId: input.connection_id })
    return { ok: false, code: 'SPEND_SETTINGS_FAILED' }
  }
  const reevaluated = await reevaluateSpendItems(client, connection, next)
  return { ok: true, data: { connection_id: input.connection_id, settings: next, reevaluated_items: reevaluated } }
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export interface ListSpendItemsInput {
  from?: string
  to?: string
  status?: SpendItemSummaryRow['status']
  connection_id?: string
  limit?: number
  offset?: number
}

export async function listSpendItems(
  ctx: OperationContext,
  input: ListSpendItemsInput,
): Promise<OperationOutcome<{ items: SpendItemSummaryRow[]; total: number }>> {
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 200)
  const offset = Math.max(input.offset ?? 0, 0)
  let query = ctx.supabase
    .from('spend_items')
    .select(SPEND_ITEM_SUMMARY_COLUMNS, { count: 'exact' })
    .eq('company_id', ctx.companyId)
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (input.from) query = query.gte('expense_date', input.from)
  if (input.to) query = query.lte('expense_date', input.to)
  if (input.status) query = query.eq('status', input.status)
  if (input.connection_id) query = query.eq('connection_id', input.connection_id)
  const { data, error, count } = await query
  if (error) {
    ctx.log.error('spend items read failed', error)
    return { ok: false, code: 'SPEND_READ_FAILED' }
  }
  return {
    ok: true,
    data: { items: ((data ?? []) as unknown as SpendItemSummaryRow[]).map(normalizeItemSummary), total: count ?? 0 },
  }
}

export interface SpendItemDetail {
  item: SpendItemRow
  connection: Pick<SpendConnectionRow, 'id' | 'provider' | 'provider_name' | 'status'> & { settings: SpendSettings }
  description: string
  /** The verifikat this expense books as now, or would book as; empty while something needs a person or the kind books nothing. */
  proposal: { lines: ReturnType<typeof buildSpendItemEntry>['lines'] }
  reasons: SpendReason[]
}

export async function getSpendItem(ctx: OperationContext, input: { item_id: string }): Promise<OperationOutcome<SpendItemDetail>> {
  const { data: item } = await ctx.supabase
    .from('spend_items')
    .select(`${SPEND_ITEM_SUMMARY_COLUMNS}, expense`)
    .eq('id', input.item_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!item) return { ok: false, code: 'SPEND_ITEM_NOT_FOUND', details: { item_id: input.item_id } }
  const row = normalizeItemSummary(item as unknown as SpendItemRow)
  const { data: connection } = await ctx.supabase
    .from('spend_connections')
    .select('id, provider, provider_name, status, settings')
    .eq('id', row.connection_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!connection) return { ok: false, code: 'SPEND_ITEM_NOT_FOUND', details: { item_id: input.item_id } }
  const conn = connection as unknown as SpendConnectionRow
  const settings = resolveSpendSettings(conn.settings)

  let reasons = row.reasons
  let lines: ReturnType<typeof buildSpendItemEntry>['lines'] = []
  if (!row.journal_entry_id && (row.status === 'ready' || row.status === 'review')) {
    // A read: everything it needs is the member's to read.
    const client = ctx.supabase
    const company = await loadSpendCompanyContext(client, ctx.companyId)
    const evaluation = evaluateSpendExpense(
      row.expense,
      await evaluationContextFor(client, ctx.companyId, row.expense, {
        isBookableAccount: await loadBookableAccounts(client, ctx.companyId),
        company,
        settings,
        providerName: conn.provider_name,
      }),
    )
    reasons = evaluation.reasons
    if (evaluation.status !== 'rejected') {
      lines = buildSpendItemEntry(row.expense, {
        settings,
        vatRegistered: company.vatRegistered,
        chart: await fetchChartVatTreatments(client, ctx.companyId),
      }).lines
    }
  }
  return {
    ok: true,
    data: {
      item: row,
      connection: { id: conn.id, provider: conn.provider, provider_name: conn.provider_name, status: conn.status, settings },
      description: spendItemDescription(row.expense, conn.provider_name),
      proposal: { lines },
      reasons,
    },
  }
}

export async function fetchSpendNow(
  ctx: OperationContext,
  input: { connection_id?: string },
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ results: SpendSyncResult[] }>> {
  if (await isSandboxCompany(ctx.supabase, ctx.companyId)) return { ok: false, code: 'SPEND_SANDBOX_BLOCKED' }
  let query = ctx.supabase.from('spend_connections').select('id').eq('company_id', ctx.companyId).eq('status', 'active')
  if (input.connection_id) query = query.eq('id', input.connection_id)
  const { data } = await query
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (ids.length === 0) return { ok: false, code: 'SPEND_CONNECTION_NOT_FOUND', details: { connection_id: input.connection_id ?? null } }
  if (options.dryRun) return { ok: true, dryRun: true, preview: { connection_ids: ids } }

  const client = admin()
  const results: SpendSyncResult[] = []
  for (const id of ids) results.push(await syncSpendConnection(client, id, { log: ctx.log, connect: connectDeps }))
  return { ok: true, data: { results } }
}
