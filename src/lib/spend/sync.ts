import type { SupabaseClient } from '@supabase/supabase-js'
import type { SpendAckResult, SpendExpense } from '@accounted/connect-contract'
import { SPEND_ACK_MAX, SPEND_EXPENSES_PAGE_MAX } from '@accounted/connect-contract'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { isStandardBASAccount } from '@/lib/bookkeeping/bas-reference'
import { DimensionValidationError } from '@/lib/bookkeeping/dimension-errors'
import { validateEntryDimensions } from '@/lib/bookkeeping/dimension-resolver'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getCanonicalAppOrigin } from '@/lib/domains/trusted-app-origin'
import type { SafeFetchDeps } from '@/lib/http/safe-fetch'
import type { Logger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  SPEND_ACTION_REQUIRED_CODES,
  SpendConnectError,
  acknowledgeSpendExpenses,
  fetchSpendExpenses,
  sendSpendMasterData,
  type SpendConnectDeps,
} from './connect-client'
import { evaluateSpendExpense, type SpendEvaluation, type SpendEvaluationContext } from './evaluate'
import { buildSpendMasterData, loadSpendCompanyContext, type SpendCompanyContext } from './master-data'
import { receiptRejectionSv, storeSpendReceipts } from './receipts'
import { resolveSpendSettings, type SpendSettings } from './settings'
import { SPEND_CONNECTION_SERVER_COLUMNS, type SpendConnectionServerRow, type SpendExpenseModel } from './types'

/**
 * Receive a connection's expenses from Connect and store them.
 *
 * A run holds the connection's lease, so the cron and a person pressing
 * "Hämta nu" never take the same expenses at once. Per run:
 *
 *   1. the coding vocabulary (accounts, VAT codes, dimensions) goes to
 *      Connect when it changed, or once a day, so the provider offers the
 *      company's own codes;
 *   2. waiting expenses are pulled page by page, oldest first. Each is
 *      stored (a new row, or the unbooked row updated), checked
 *      (lib/spend/evaluate.ts), its receipts archived, and answered:
 *      received, or rejected with the Swedish reason the provider shows.
 *      An expense whose receipt could not be downloaded right now is left
 *      unanswered and comes back on the next run with a fresh link.
 *
 * A booked expense is never rewritten: a different answer for it only marks
 * it changed_after_booking for a person to look at. Nothing is booked here.
 *
 * Writes use the service role: members only read these tables.
 */

const LEASE_MS = 5 * 60 * 1000
/** The provider gives an export an hour; Connect answers for us after 45 minutes. Poll well inside that. */
const POLL_INTERVAL_MS = 5 * 60 * 1000
const MASTER_DATA_REFRESH_MS = 24 * 60 * 60 * 1000
const MAX_PAGES = 4
const BACKOFF_BASE_MS = 5 * 60 * 1000
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
const ACTION_REQUIRED_RETRY_MS = 6 * 60 * 60 * 1000
/** Failures in a row after which a transient problem needs a person. */
const FAILURES_UNTIL_ACTION = 12

const RATE_LIMITED_CODES = new Set(['CONNECTOR_SPEND_PROVIDER_RATE_LIMITED', 'CONNECTOR_RATE_LIMITED'])

export type SpendSyncStatus = 'synced' | 'locked' | 'inactive' | 'failed'

export interface SpendSyncResult {
  connectionId: string
  status: SpendSyncStatus
  /** Expenses answered as received in this run. */
  received: number
  /** Expenses answered as rejected in this run. */
  rejected: number
  /** Expenses left unanswered until a receipt downloads. */
  deferred: number
  /** Booked expenses the provider sent again with another answer. */
  changedAfterBooking: number
  masterData: 'sent' | 'unchanged' | 'failed'
  errorCode?: string
  retryable?: boolean
  /** The caller's deadline stopped the run before its pages were read; the next run reads the rest. */
  stoppedEarly?: boolean
}

export interface SpendSyncOptions {
  now?: Date
  log: Logger
  connect?: SpendConnectDeps
  receipts?: SafeFetchDeps
  maxPages?: number
  /**
   * Absolute deadline (epoch ms) from the cron's time budget, checked before
   * each page is read: one page can wait 65 s at Connect and a run is up to
   * MAX_PAGES of them, so a budget checked only between connections lets one
   * started near its end run past the cron's maxDuration. A stopped run
   * releases the lease with what it answered.
   */
  deadlineMs?: number
}

async function claimLease(admin: SupabaseClient, connectionId: string, now: Date): Promise<SpendConnectionServerRow | null> {
  const { data, error } = await admin
    .from('spend_connections')
    .update({ lease_until: new Date(now.getTime() + LEASE_MS).toISOString() })
    .eq('id', connectionId)
    .eq('status', 'active')
    .lt('lease_until', now.toISOString())
    .select(SPEND_CONNECTION_SERVER_COLUMNS)
  if (error) throw new Error(`spend lease claim failed: ${error.message}`)
  return ((data ?? [])[0] as unknown as SpendConnectionServerRow | undefined) ?? null
}

/**
 * Which accounts the engine can book on: an active chart account, or a
 * standard BAS account the chart does not hold yet (the engine seeds it on
 * first use). A deactivated account never is: the engine never reactivates.
 */
export async function loadBookableAccounts(admin: SupabaseClient, companyId: string): Promise<(account: string) => boolean> {
  const rows = await fetchAllRows<{ account_number: string; is_active: boolean }>(({ from, to }) =>
    admin
      .from('chart_of_accounts')
      .select('account_number, is_active')
      .eq('company_id', companyId)
      .order('account_number', { ascending: true })
      .range(from, to),
  )
  const active = new Set(rows.filter((r) => r.is_active).map((r) => r.account_number))
  const inactive = new Set(rows.filter((r) => !r.is_active).map((r) => r.account_number))
  return (account: string) => active.has(account) || (!inactive.has(account) && isStandardBASAccount(account))
}

/** The context evaluateSpendExpense needs for one expense: the period of its date and its dimension codes. */
export async function evaluationContextFor(
  admin: SupabaseClient,
  companyId: string,
  expense: SpendExpenseModel,
  base: {
    isBookableAccount: (account: string) => boolean
    company: SpendCompanyContext
    settings: SpendSettings
    providerName: string
    periodCache?: Map<string, { locked: boolean; hasFiscalPeriod: boolean }>
  },
): Promise<SpendEvaluationContext> {
  let period = base.periodCache?.get(expense.date)
  if (!period) {
    const verdict = await checkPeriodLock(admin, companyId, expense.date)
    period = { locked: verdict.locked, hasFiscalPeriod: verdict.reason !== 'no_fiscal_period' }
    base.periodCache?.set(expense.date, period)
  }
  let dimensionProblem: SpendEvaluationContext['dimensionProblem'] = null
  if (base.company.dimensionsEnabled && expense.lines.some((line) => Object.keys(line.dimensions).length > 0)) {
    try {
      await validateEntryDimensions(admin, companyId, expense.lines.map((line) => ({ dimensions: line.dimensions })))
    } catch (err) {
      if (!(err instanceof DimensionValidationError)) throw err
      const issue = err.issues[0]
      dimensionProblem = { dimension: issue?.dimension_name ?? `Dimension ${issue?.sie_dim_no ?? ''}`.trim(), value: issue?.code ?? '' }
    }
  }
  return {
    isBookableAccount: base.isBookableAccount,
    vatRegistered: base.company.vatRegistered,
    settings: base.settings,
    providerName: base.providerName,
    period,
    dimensionProblem,
  }
}

function modelOf(expense: SpendExpense): SpendExpenseModel {
  const { raw: _raw, ...model } = expense
  return model
}

/** Where a person finds an expense in this installation, for the provider's link back. */
export function spendItemUrl(itemId: string): string {
  return `${getCanonicalAppOrigin()}/kortkop?item=${itemId}`
}

type StoredOutcome =
  | { kind: 'answer'; result: SpendAckResult; itemId: string; changedAfterBooking: boolean }
  | { kind: 'deferred'; itemId: string }

interface StoreContext {
  connection: SpendConnectionServerRow
  company: SpendCompanyContext
  settings: SpendSettings
  isBookableAccount: (account: string) => boolean
  periodCache: Map<string, { locked: boolean; hasFiscalPeriod: boolean }>
  now: Date
  receipts?: SafeFetchDeps
}

function rejectionAnswer(expense: SpendExpense, evaluation: SpendEvaluation): SpendAckResult {
  return {
    externalId: expense.externalId,
    outcome: 'rejected',
    reasonCode: evaluation.rejection!.code,
    reasonSv: evaluation.rejection!.reasonSv,
  }
}

/** Store one expense and decide its answer. Never rewrites a booked expense. */
export async function storeSpendExpense(admin: SupabaseClient, expense: SpendExpense, ctx: StoreContext): Promise<StoredOutcome> {
  const { connection } = ctx
  const { data: existing, error: readError } = await admin
    .from('spend_items')
    .select('id, journal_entry_id, raw_sha256, receive_count, changed_after_booking, latest_raw_sha256, document_ids, ack_outcome, status')
    .eq('company_id', connection.company_id)
    .eq('provider', connection.provider)
    .eq('external_id', expense.externalId)
    .maybeSingle()
  if (readError) throw new Error(`spend item read failed: ${readError.message}`)
  const row = existing as {
    id: string
    journal_entry_id: string | null
    raw_sha256: string
    receive_count: number
    changed_after_booking: boolean
    latest_raw_sha256: string | null
    document_ids: string[] | null
    ack_outcome: string | null
    status: string
  } | null

  const received = (itemId: string, changedAfterBooking = false): StoredOutcome => ({
    kind: 'answer',
    itemId,
    changedAfterBooking,
    result: { externalId: expense.externalId, outcome: 'received', ledgerRef: itemId, ledgerUrl: spendItemUrl(itemId) },
  })

  // A booked expense keeps what it was booked from; a different answer is a flag.
  if (row?.journal_entry_id) {
    const differs = row.raw_sha256 !== expense.raw.sha256
    const { error } = await admin
      .from('spend_items')
      .update({
        latest_received_at: ctx.now.toISOString(),
        changed_after_booking: differs || row.changed_after_booking,
        latest_raw_sha256: differs ? expense.raw.sha256 : row.latest_raw_sha256,
      })
      .eq('id', row.id)
    if (error) throw new Error(`spend booked item flag failed: ${error.message}`)
    return received(row.id, differs)
  }

  const model = modelOf(expense)
  const evaluation = evaluateSpendExpense(
    model,
    await evaluationContextFor(admin, connection.company_id, model, {
      isBookableAccount: ctx.isBookableAccount,
      company: ctx.company,
      settings: ctx.settings,
      providerName: connection.provider_name,
      periodCache: ctx.periodCache,
    }),
  )
  const receivedAt = ctx.now.toISOString()
  // The expense's columns are written out in both statements below (not
  // built once and spread) so the schema guard checks every column name.
  let itemId: string
  if (row) {
    const { data: updated, error } = await admin
      .from('spend_items')
      .update({
        connection_id: connection.id,
        batch_ref: expense.batchRef,
        kind: expense.kind,
        expense_date: expense.date,
        currency: expense.currency,
        amount: expense.amount,
        merchant_name: expense.merchant?.name ?? null,
        person_name: expense.person?.name ?? null,
        status: evaluation.status,
        reasons: evaluation.reasons,
        expense: model,
        raw_body: expense.raw.body,
        raw_content_type: expense.raw.contentType,
        raw_sha256: expense.raw.sha256,
        received_at: receivedAt,
        receive_count: row.receive_count + 1,
        // A different answer brings its own receipts; the same one keeps those already stored.
        document_ids: row.raw_sha256 !== expense.raw.sha256 ? [] : (row.document_ids ?? []),
        ack_outcome: null,
        acknowledged_at: null,
      })
      .eq('id', row.id)
      .is('journal_entry_id', null)
      .select('id')
    if (error) throw new Error(`spend item update failed: ${error.message}`)
    // A booking claimed the row a moment ago: this answer becomes a flag on it.
    if (!updated || updated.length === 0) return storeSpendExpense(admin, expense, ctx)
    itemId = row.id
  } else {
    const { data: inserted, error: insertError } = await admin
      .from('spend_items')
      .insert({
        company_id: connection.company_id,
        connection_id: connection.id,
        provider: connection.provider,
        external_id: expense.externalId,
        batch_ref: expense.batchRef,
        kind: expense.kind,
        expense_date: expense.date,
        currency: expense.currency,
        amount: expense.amount,
        merchant_name: expense.merchant?.name ?? null,
        person_name: expense.person?.name ?? null,
        status: evaluation.status,
        reasons: evaluation.reasons,
        expense: model,
        raw_body: expense.raw.body,
        raw_content_type: expense.raw.contentType,
        raw_sha256: expense.raw.sha256,
        received_at: receivedAt,
        receive_count: 1,
      })
      .select('id')
      .single()
    if (insertError) {
      // A concurrent run stored the expense first: store over it instead.
      if (insertError.code === '23505') return storeSpendExpense(admin, expense, ctx)
      throw new Error(`spend item insert failed: ${insertError.message}`)
    }
    itemId = (inserted as { id: string }).id
  }

  if (evaluation.status === 'rejected') return { kind: 'answer', itemId, changedAfterBooking: false, result: rejectionAnswer(expense, evaluation) }
  if (expense.files.length === 0) return received(itemId)

  const unchangedFiles = row && row.raw_sha256 === expense.raw.sha256 && (row.document_ids ?? []).length === expense.files.length
  if (unchangedFiles) return received(itemId)
  if (!connection.created_by) {
    // Documents are stored under a person; without the one who connected,
    // nobody can hold them. Reconnecting sets a new owner.
    return {
      kind: 'answer',
      itemId,
      changedAfterBooking: false,
      result: {
        externalId: expense.externalId,
        outcome: 'rejected',
        reasonCode: 'internal_error',
        reasonSv: 'Accounted kan inte spara kvittot just nu. Koppla plattformen på nytt i Accounted och exportera igen.',
      },
    }
  }
  const stored = await storeSpendReceipts(
    admin,
    { companyId: connection.company_id, userId: connection.created_by, itemId, files: expense.files },
    ctx.receipts,
  )
  if (!stored.ok) {
    if (!stored.permanent) return { kind: 'deferred', itemId }
    const reasonSv = receiptRejectionSv(stored)
    const { error } = await admin
      .from('spend_items')
      .update({ status: 'rejected', reasons: [{ code: 'receipt_unusable', params: { file: stored.fileName, reason: stored.reason } }] })
      .eq('id', itemId)
      .is('journal_entry_id', null)
    if (error) throw new Error(`spend item receipt rejection failed: ${error.message}`)
    return {
      kind: 'answer',
      itemId,
      changedAfterBooking: false,
      result: { externalId: expense.externalId, outcome: 'rejected', reasonCode: 'receipt_unusable', reasonSv },
    }
  }
  const { error: docsError } = await admin
    .from('spend_items')
    .update({ document_ids: stored.documentIds })
    .eq('id', itemId)
    .is('journal_entry_id', null)
  if (docsError) throw new Error(`spend item documents failed: ${docsError.message}`)
  return received(itemId)
}

function failureHealth(connection: SpendConnectionServerRow, err: SpendConnectError, now: Date): Record<string, unknown> {
  const failures = connection.failures_in_row + 1
  let health: 'degraded' | 'action_required' = 'degraded'
  let retryInMs = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
  if (SPEND_ACTION_REQUIRED_CODES.has(err.code) || (!err.retryable && !RATE_LIMITED_CODES.has(err.code))) {
    health = 'action_required'
    retryInMs = ACTION_REQUIRED_RETRY_MS
  } else if (RATE_LIMITED_CODES.has(err.code)) {
    retryInMs = Math.max((err.retryAfterSec ?? 0) * 1000, BACKOFF_BASE_MS)
  } else if (failures >= FAILURES_UNTIL_ACTION) {
    health = 'action_required'
  }
  return {
    health,
    health_code: err.code,
    last_error_code: err.code,
    last_error_at: now.toISOString(),
    failures_in_row: failures,
    next_run_at: new Date(now.getTime() + retryInMs).toISOString(),
  }
}

async function sendMasterDataIfDue(
  admin: SupabaseClient,
  connection: SpendConnectionServerRow,
  company: SpendCompanyContext,
  now: Date,
  options: SpendSyncOptions,
): Promise<'sent' | 'unchanged' | 'failed'> {
  const { body, sha256 } = await buildSpendMasterData(admin, connection.company_id, company)
  const sentAt = connection.master_data_sent_at ? new Date(connection.master_data_sent_at).getTime() : 0
  if (connection.master_data_sha256 === sha256 && now.getTime() - sentAt < MASTER_DATA_REFRESH_MS) return 'unchanged'
  try {
    await sendSpendMasterData(
      connection.company_id,
      connection.connection_handle!,
      { idempotencyKey: `${connection.id}:${sha256.slice(0, 40)}:${todayIsoStockholm(now)}`, ...body },
      options.connect,
    )
  } catch (err) {
    if (err instanceof SpendConnectError) {
      options.log.warn('spend master data send failed', { connectionId: connection.id, code: err.code })
      if (SPEND_ACTION_REQUIRED_CODES.has(err.code)) throw err
      return 'failed'
    }
    throw err
  }
  const { error } = await admin
    .from('spend_connections')
    .update({ master_data_sha256: sha256, master_data_sent_at: now.toISOString() })
    .eq('id', connection.id)
  if (error) options.log.error('spend master data mark failed', error, { connectionId: connection.id })
  return 'sent'
}

async function acknowledge(
  admin: SupabaseClient,
  connection: SpendConnectionServerRow,
  answers: Array<{ itemId: string; result: SpendAckResult }>,
  now: Date,
  options: SpendSyncOptions,
): Promise<void> {
  for (let i = 0; i < answers.length; i += SPEND_ACK_MAX) {
    const chunk = answers.slice(i, i + SPEND_ACK_MAX)
    const response = await acknowledgeSpendExpenses(
      connection.company_id,
      connection.connection_handle!,
      chunk.map((answer) => answer.result),
      options.connect,
    )
    if (response.unknown.length > 0) {
      options.log.warn('spend acknowledgement named expenses Connect no longer holds', {
        connectionId: connection.id,
        unknown: response.unknown.length,
      })
    }
    for (const outcome of ['received', 'rejected'] as const) {
      const ids = chunk.filter((answer) => answer.result.outcome === outcome).map((answer) => answer.itemId)
      if (ids.length === 0) continue
      const { error } = await admin
        .from('spend_items')
        .update({ ack_outcome: outcome, acknowledged_at: now.toISOString() })
        .in('id', ids)
      if (error) options.log.error('spend acknowledgement mark failed', error, { connectionId: connection.id })
    }
  }
}

export async function syncSpendConnection(admin: SupabaseClient, connectionId: string, options: SpendSyncOptions): Promise<SpendSyncResult> {
  const now = options.now ?? new Date()
  const log = options.log
  const result: SpendSyncResult = {
    connectionId,
    status: 'synced',
    received: 0,
    rejected: 0,
    deferred: 0,
    changedAfterBooking: 0,
    masterData: 'unchanged',
  }

  const connection = await claimLease(admin, connectionId, now)
  if (!connection) {
    const { data } = await admin.from('spend_connections').select('status').eq('id', connectionId).maybeSingle()
    return { ...result, status: (data as { status: string } | null)?.status === 'active' ? 'locked' : 'inactive' }
  }

  let failure: SpendConnectError | null = null
  let pagesRead = 0
  try {
    if (!connection.connection_handle) {
      throw new SpendConnectError('The connection has no handle', { code: 'CONNECTOR_CONNECTION_NOT_OWNED', retryable: false })
    }
    const company = await loadSpendCompanyContext(admin, connection.company_id)
    result.masterData = await sendMasterDataIfDue(admin, connection, company, now, options)

    const settings = resolveSpendSettings(connection.settings)
    const isBookableAccount = await loadBookableAccounts(admin, connection.company_id)
    const periodCache = new Map<string, { locked: boolean; hasFiscalPeriod: boolean }>()
    const storeContext: StoreContext = { connection, company, settings, isBookableAccount, periodCache, now, receipts: options.receipts }

    const maxPages = options.maxPages ?? MAX_PAGES
    for (let page = 0; page < maxPages; page += 1) {
      if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
        result.stoppedEarly = true
        log.info('spend sync stopped on the time budget; the rest is read next run', { connectionId, pagesRead })
        break
      }
      const answer = await fetchSpendExpenses(connection.company_id, connection.connection_handle, { limit: SPEND_EXPENSES_PAGE_MAX }, options.connect)
      pagesRead += 1
      const answers: Array<{ itemId: string; result: SpendAckResult }> = []
      for (const expense of answer.expenses) {
        const stored = await storeSpendExpense(admin, expense, storeContext)
        if (stored.kind === 'deferred') {
          result.deferred += 1
          continue
        }
        answers.push({ itemId: stored.itemId, result: stored.result })
        if (stored.result.outcome === 'received') result.received += 1
        else result.rejected += 1
        if (stored.changedAfterBooking) result.changedAfterBooking += 1
      }
      if (answers.length > 0) await acknowledge(admin, connection, answers, now, options)
      // A page of only deferred expenses would come back unchanged: wait for the next run.
      if (!answer.more || answers.length === 0) break
    }
  } catch (err) {
    if (!(err instanceof SpendConnectError)) {
      // Release the lease before the error leaves: the next run may retry.
      await admin.from('spend_connections').update({ lease_until: new Date(0).toISOString() }).eq('id', connectionId)
      throw err
    }
    failure = err
  }

  if (!failure && result.stoppedEarly && pagesRead === 0) {
    // The deadline came before the first page: nothing was learned about the
    // connection, so only the lease is released. Its health, failure count
    // and last success stay what they were; writing "ok" here would clear a
    // connection that waits for a person without a single page read.
    const { error: releaseError } = await admin
      .from('spend_connections')
      .update({
        lease_until: new Date(0).toISOString(),
        next_run_at: new Date(now.getTime() + POLL_INTERVAL_MS).toISOString(),
      })
      .eq('id', connectionId)
    if (releaseError) log.error('spend connection release failed', releaseError, { connectionId })
    return result
  }

  const failed = failure ? failureHealth(connection, failure, now) : null
  if (failure) {
    result.status = 'failed'
    result.errorCode = failure.code
    result.retryable = failure.retryable
    log.warn('spend sync failed', { connectionId, code: failure.code, status: failure.status, retryable: failure.retryable })
  }
  // The lease holder is the only writer of these columns, so the row read at the claim is current.
  const { error: releaseError } = await admin
    .from('spend_connections')
    .update({
      lease_until: new Date(0).toISOString(),
      health: failed ? failed.health : 'ok',
      health_code: failed ? failed.health_code : null,
      failures_in_row: failed ? failed.failures_in_row : 0,
      last_error_code: failed ? failed.last_error_code : connection.last_error_code,
      last_error_at: failed ? failed.last_error_at : connection.last_error_at,
      last_success_at: failed ? connection.last_success_at : now.toISOString(),
      next_run_at: failed ? failed.next_run_at : new Date(now.getTime() + POLL_INTERVAL_MS).toISOString(),
    })
    .eq('id', connectionId)
  if (releaseError) log.error('spend connection release failed', releaseError, { connectionId })
  return result
}

/**
 * Re-evaluate every unbooked, received expense of a connection after its
 * settings changed: an expense that waited on an account may now be ready.
 * Rejected expenses are not touched: the provider already has them back,
 * and an export brings them here again.
 */
export async function reevaluateSpendItems(
  admin: SupabaseClient,
  connection: Pick<SpendConnectionServerRow, 'id' | 'company_id' | 'provider_name'>,
  settings: SpendSettings,
): Promise<number> {
  const rows = await fetchAllRows<{ id: string; expense: SpendExpenseModel }>(({ from, to }) =>
    admin
      .from('spend_items')
      .select('id, expense')
      .eq('connection_id', connection.id)
      .is('journal_entry_id', null)
      .in('status', ['ready', 'review'])
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (rows.length === 0) return 0
  const company = await loadSpendCompanyContext(admin, connection.company_id)
  const isBookableAccount = await loadBookableAccounts(admin, connection.company_id)
  const periodCache = new Map<string, { locked: boolean; hasFiscalPeriod: boolean }>()
  let changed = 0
  for (const row of rows) {
    const evaluation = evaluateSpendExpense(
      row.expense,
      await evaluationContextFor(admin, connection.company_id, row.expense, {
        isBookableAccount,
        company,
        settings,
        providerName: connection.provider_name,
        periodCache,
      }),
    )
    // A setting never turns a received expense into a rejection here: the
    // provider already counts it as delivered, so it waits for a person.
    const status = evaluation.status === 'rejected' ? 'review' : evaluation.status
    const { error } = await admin
      .from('spend_items')
      .update({ status, reasons: evaluation.reasons })
      .eq('id', row.id)
      .is('journal_entry_id', null)
    if (error) throw new Error(`spend re-evaluation failed: ${error.message}`)
    changed += 1
  }
  return changed
}
