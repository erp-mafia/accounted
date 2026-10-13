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
 *
 * A failure throws: each door maps it to its own answer.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { INITIAL_SYNC_TIMEOUT } from '@/lib/bank-sync/initial-sync-error'
import { persistBankSyncResult } from '@/lib/bank-sync/persist-sync-result'
import {
  runUnattendedReconciliationSweep,
  toSweepSummary,
} from '@/lib/reconciliation/unattended-sweep'
import { syncAccountTransactions, type IngestFn, type SyncOptions, type SyncResult } from './sync'
import type { StoredAccount } from '../types'

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
  completedAt: string
}

export async function runConnectionSync(input: ConnectionSyncInput): Promise<ConnectionSyncOutcome> {
  const { supabase, companyId, userId, connection, accounts, fromDate, toDate, log } = input
  const rawInsertOnly = input.rawInsertOnly === true

  const { data: sieOverlap } = await supabase
    .from('sie_imports')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .gte('fiscal_year_end', fromDate)
    .limit(1)
    .maybeSingle()
  if (sieOverlap) {
    log.info('SIE import overlap detected: suppressing auto-categorization', {
      connectionId: connection.id,
      sieImportId: sieOverlap.id,
      fromDate,
      toDate,
    })
  }

  const syncOptions: SyncOptions = {
    ...(sieOverlap ? { skipAutoCategorization: true } : {}),
    ...(rawInsertOnly ? { rawInsertOnly: true } : {}),
    ...(input.firstSync || input.lookbackDays >= LONGEST_STRATEGY_MIN_DAYS ? { strategy: 'longest' as const } : {}),
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
  const minDates = results.map((r) => r.returnedMinBookingDate).filter((d): d is string => !!d)
  const maxDates = results.map((r) => r.returnedMaxBookingDate).filter((d): d is string => !!d)
  const returnedMin = minDates.length > 0 ? minDates.reduce((a, b) => (a < b ? a : b)) : null
  const returnedMax = maxDates.length > 0 ? maxDates.reduce((a, b) => (a > b ? a : b)) : null
  const narrowedFrom = results
    .filter((r) => r.historyNarrowed && r.effectiveFromDate)
    .map((r) => r.effectiveFromDate as string)
  const historyFrom = narrowedFrom.length > 0 ? narrowedFrom.reduce((a, b) => (a > b ? a : b)) : null

  // A viewer cannot update transactions, so a viewer's sync never sweeps.
  let autoMatched = 0
  if (sieOverlap && imported > 0 && !rawInsertOnly) {
    // Some banks over-return history: rows older than the requested window
    // were ingested too and must be swept, or they surface as unhandled.
    const sweepFrom = returnedMin && returnedMin < fromDate ? returnedMin : fromDate
    try {
      // Only the accounts this sync fetched, each in its own cash-account
      // scope, never the pooled form that can cross-link accounts (#1290).
      const ledgerAccounts = Array.from(
        new Set(accounts.map((a) => a.ledger_account).filter((l): l is string => typeof l === 'string' && l.length > 0)),
      )
      const sweep = await runUnattendedReconciliationSweep(supabase, companyId, userId, {
        dateFrom: sweepFrom,
        dateTo: toDate,
        ledgerAccounts,
      })
      autoMatched = sweep.applied
      // Stamped so the UI can say "Vi matchade X av Y" and the review surface
      // knows there is something to granska.
      await supabase
        .from('bank_connections')
        .update({ last_sie_sweep: toSweepSummary(sweep, { dateFrom: sweepFrom, dateTo: toDate }) })
        .eq('id', connection.id)
      if (sweep.applied > 0 || sweep.skippedBelowThreshold > 0) {
        log.info('Post-sync reconciliation linked imported rows to existing verifikat', {
          connectionId: connection.id,
          applied: sweep.applied,
          skippedBelowThreshold: sweep.skippedBelowThreshold,
          accounts: sweep.accounts.map((a) => ({
            accountNumber: a.accountNumber,
            applied: a.applied,
            skippedBelowThreshold: a.skippedBelowThreshold,
          })),
        })
      }
    } catch (sweepError) {
      // Non-critical: the rows stay unmatched for manual review.
      log.warn('Post-sync reconciliation sweep failed', {
        connectionId: connection.id,
        message: sweepError instanceof Error ? sweepError.message : String(sweepError),
      })
    }
  }

  const completedAt = new Date().toISOString()
  await persistBankSyncResult(supabase, {
    companyId,
    connectionId: connection.id,
    sessionId: connection.session_id,
    startedAt: input.startedAt,
    completedAt,
    accounts,
    ...(input.firstSync
      ? { initialSync: { requestedFrom: fromDate, returnedMin, returnedMax, lookbackDays: input.lookbackDays } }
      : {}),
  })

  return {
    results,
    imported,
    duplicates,
    errors,
    returnedMin,
    returnedMax,
    historyFrom,
    sieOverlap: Boolean(sieOverlap),
    autoMatched,
    completedAt,
  }
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
