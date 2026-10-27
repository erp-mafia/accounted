/**
 * One bank connection's sync, shared by every door that starts one: the
 * "Synka nu" route, the initial backfill after the account picker, the
 * agent-triggered sync (v1 and MCP) and the daily cron.
 *
 * The doors differ only in what surrounds a sync: who may ask, how far back,
 * the lease or cooldown in front of it, and how a failure is answered. What
 * a sync is lives here once:
 *   - the SIE-overlap guard: a window a completed SIE import already covers
 *     is never auto-categorised (double-booking), only linked;
 *   - the fetch options (raw insert for a viewer, the deepest history for a
 *     window of 30 days or more);
 *   - one fetch per account, in parallel;
 *   - after an overlapping import, the unattended reconciliation sweep that
 *     links the new rows to the verifikat that already describe them: over
 *     the fetched accounts only, from the oldest date the bank returned;
 *   - persisting the result (and, on a first sync, what the bank returned).
 *     A first sync completes only when every account was read to its end: a
 *     read the bank had not finished (truncated) leaves the first import
 *     owed, so the cron asks again instead of recording an empty or partial
 *     history as the whole of it (PH 195);
 *   - announcing the rows it inserted, once (transaction.synced), as the Open
 *     Payments feed and the bank-file import do: from every door, the cron
 *     included, so event_log and the inbox bank match see every arrival.
 *
 * A failure throws: each door maps it to its own answer.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { INITIAL_SYNC_TIMEOUT } from '@/lib/bank-sync/initial-sync-error'
import { persistBankSyncResult } from '@/lib/bank-sync/persist-sync-result'
import { sweepAfterOverlappingSync } from '@/lib/bank-sync/post-sync-sweep'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { chunk } from '@/lib/utils'
import type { Transaction } from '@/types'
import { syncAccountTransactions, type IngestFn, type SyncOptions, type SyncResult } from './sync'
import type { StoredAccount } from '../types'

const errorLog = createLogger('enable-banking/run-connection-sync')

/** Ids per read of the inserted rows: keeps the PostgREST URL short on a 90-day first import. */
const SYNCED_ROWS_READ_CHUNK = 200

/** A window this long or longer asks the bank for its deepest history. */
export const LONGEST_STRATEGY_MIN_DAYS = 30

export interface ConnectionSyncLog {
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
}

export interface ConnectionSyncInput {
  supabase: SupabaseClient
  companyId: string
  /** Whose sync it is: the caller, or the connection's owner for the cron. */
  userId: string
  connection: { id: string; session_id: string | null }
  /** The accounts to fetch: the door has kept only synced ones (isSyncedAccount). */
  accounts: StoredAccount[]
  fromDate: string
  toDate: string
  /** Days the window spans: 30 or more, or a first sync, asks for the deepest history. */
  lookbackDays: number
  /** A first sync: its window and what the bank returned are persisted with it. */
  firstSync?: boolean
  /** A viewer's sync stores rows only: no categorising, no reconciliation. */
  rawInsertOnly?: boolean
  ingest?: IngestFn
  /** When the sync started (ISO), the watermark persist checks against. */
  startedAt: string
  /**
   * Give up on the bank after this long, with INITIAL_SYNC_TIMEOUT. The
   * fetches keep running and are left to the next sync; nothing is
   * persisted from them.
   */
  fetchTimeoutMs?: number
  /**
   * The person who asked ("Synka nu", the first import after the account
   * picker): their reads do not count against the consent's background
   * budget. Never set by the cron or the agent sync.
   */
  signer?: SyncOptions['signer']
  log: ConnectionSyncLog
}

export interface ConnectionSyncOutcome {
  results: SyncResult[]
  imported: number
  duplicates: number
  errors: number
  /** Oldest and newest booking dates the bank returned, across the accounts. */
  returnedMin: string | null
  returnedMax: string | null
  /**
   * When a bank refused the window and answered a narrower one: the date from
   * which every account is complete (#2202). Null when nothing was narrowed.
   */
  historyFrom: string | null
  sieOverlap: boolean
  /** Rows the post-sync sweep linked to existing verifikat. */
  autoMatched: number
  /**
   * At least one account's read stopped while the bank still had pages: the
   * window is incomplete, and a first sync is not recorded as completed.
   */
  truncated: boolean
  /** Entries the banks sent that are not booked yet, across the accounts (PH 221). */
  notBooked: number
  completedAt: string
}

export async function runConnectionSync(input: ConnectionSyncInput): Promise<ConnectionSyncOutcome> {
  const { supabase, companyId, userId, connection, accounts, fromDate, toDate, log } = input
  const rawInsertOnly = input.rawInsertOnly === true

  const { data: sieImport, error: sieOverlapError } = await supabase
    .from('sie_imports')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .gte('fiscal_year_end', fromDate)
    .limit(1)
    .maybeSingle()
  // An unanswered check counts as an overlap: auto-categorizing rows an
  // import already booked, or skipping the sweep that links them, is what
  // books them twice (crm#1282); suppressing and sweeping costs nothing.
  if (sieOverlapError) {
    errorLog.error('SIE overlap check failed: treating the window as covered by an import', {
      connectionId: connection.id,
      companyId,
      code: sieOverlapError.code,
      message: sieOverlapError.message,
    })
  }
  const sieOverlap = Boolean(sieImport) || Boolean(sieOverlapError)
  if (sieImport) {
    log.info('SIE import overlap detected: suppressing auto-categorization', {
      connectionId: connection.id,
      sieImportId: sieImport.id,
      fromDate,
      toDate,
    })
  }

  const syncOptions: SyncOptions = {
    ...(sieOverlap ? { skipAutoCategorization: true } : {}),
    ...(rawInsertOnly ? { rawInsertOnly: true } : {}),
    ...(input.firstSync || input.lookbackDays >= LONGEST_STRATEGY_MIN_DAYS ? { strategy: 'longest' as const } : {}),
    ...(input.signer ? { signer: input.signer } : {}),
  }

  const fetches = Promise.all(
    accounts.map((account) =>
      syncAccountTransactions(
        supabase,
        companyId,
        userId,
        connection.id,
        account,
        fromDate,
        toDate,
        input.ingest,
        syncOptions,
      ),
    ),
  )
  const results = await withTimeout(fetches, input.fetchTimeoutMs)

  const imported = results.reduce((sum, r) => sum + r.imported, 0)
  const duplicates = results.reduce((sum, r) => sum + r.duplicates, 0)
  const errors = results.reduce((sum, r) => sum + r.errors, 0)
  const notBooked = results.reduce((sum, r) => sum + (r.notBooked ?? 0), 0)
  const minDates = results.map((r) => r.returnedMinBookingDate).filter((d): d is string => !!d)
  const maxDates = results.map((r) => r.returnedMaxBookingDate).filter((d): d is string => !!d)
  const returnedMin = minDates.length > 0 ? minDates.reduce((a, b) => (a < b ? a : b)) : null
  const returnedMax = maxDates.length > 0 ? maxDates.reduce((a, b) => (a > b ? a : b)) : null
  const narrowedFrom = results
    .filter((r) => r.historyNarrowed && r.effectiveFromDate)
    .map((r) => r.effectiveFromDate as string)
  const historyFrom = narrowedFrom.length > 0 ? narrowedFrom.reduce((a, b) => (a > b ? a : b)) : null
  const truncated = results.some((r) => r.truncated === true)
  if (truncated) {
    log.warn('Bank read stopped before the bank ran out of pages: the window is incomplete', {
      connectionId: connection.id,
      firstSync: input.firstSync === true,
      fromDate,
      toDate,
    })
  }

  // A viewer cannot update transactions, so a viewer's sync never sweeps.
  let autoMatched = 0
  if (sieOverlap && imported > 0 && !rawInsertOnly) {
    autoMatched = await sweepAfterOverlappingSync(supabase, {
      companyId,
      userId,
      connectionId: connection.id,
      ledgerAccounts: accounts.map((a) => a.ledger_account),
      fromDate,
      toDate,
      returnedMin,
      log,
    })
  }

  const completedAt = new Date().toISOString()
  await persistBankSyncResult(supabase, {
    companyId,
    connectionId: connection.id,
    sessionId: connection.session_id,
    startedAt: input.startedAt,
    completedAt,
    accounts,
    // A truncated first import stays owed (initial_sync_completed_at NULL):
    // the rows it did get are stored, and the cron runs the first import again.
    ...(input.firstSync && !truncated
      ? { initialSync: { requestedFrom: fromDate, returnedMin, returnedMax, lookbackDays: input.lookbackDays } }
      : {}),
  })

  // After the sweep and the persist, like the Open Payments feed: a row the
  // sweep linked arrives linked, and a sync whose result was refused
  // announces nothing. A viewer's raw insert announces nothing either (the
  // feed's rule). Awaited in every door, the cron too: the handlers are
  // bounded (event_log one batch insert, the inbox match at most
  // ITEMS_REFRESHED_PER_ARRIVAL items), and only a sync that inserted rows
  // pays for them.
  const transactionIds = results.flatMap((r) => r.transactionIds ?? [])
  if (transactionIds.length > 0 && !rawInsertOnly) {
    await announceSyncedRows(supabase, { companyId, userId, connectionId: connection.id, transactionIds, log })
  }

  return {
    results,
    imported,
    duplicates,
    errors,
    returnedMin,
    returnedMax,
    historyFrom,
    sieOverlap,
    autoMatched,
    truncated,
    notBooked,
    completedAt,
  }
}

/**
 * One transaction.synced for the rows a sync inserted, read by their ids.
 * Best effort: the rows are stored and the sync persisted, so a failed read
 * is logged and the event skipped, never thrown at the door.
 */
async function announceSyncedRows(
  supabase: SupabaseClient,
  input: { companyId: string; userId: string; connectionId: string; transactionIds: string[]; log: ConnectionSyncLog },
): Promise<void> {
  const { companyId, userId, connectionId, transactionIds, log } = input
  const transactions: Transaction[] = []
  for (const ids of chunk(transactionIds, SYNCED_ROWS_READ_CHUNK)) {
    const { data, error } = await supabase.from('transactions').select('*').eq('company_id', companyId).in('id', ids)
    if (error) {
      log.warn('synced rows not announced: the read failed', { connectionId, rows: transactionIds.length, message: error.message })
      return
    }
    transactions.push(...((data ?? []) as Transaction[]))
  }
  if (transactions.length === 0) return
  await eventBus.emit({ type: 'transaction.synced', payload: { transactions, userId, companyId } })
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (!timeoutMs) return work
  // If the timeout wins, the fetches keep running: a late rejection must
  // not surface as an unhandledRejection, which ends a Node 22 process.
  work.catch(() => {})
  let handle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(INITIAL_SYNC_TIMEOUT)), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (handle) clearTimeout(handle)
  }
}
