/**
 * After a bank sync whose window a completed SIE import already covers, link
 * the new rows to the verifikat that already describe them. Shared by both
 * aggregators' runners (Enable Banking's run-connection-sync and Open
 * Payments' bank-feed), so an imported history never lands as unhandled rows
 * on one aggregator while the other matches it (crm#1282).
 *
 *   - Only the ledger accounts the sync fetched, each in its own cash-account
 *     scope, never the pooled form that can cross-link accounts (#1290).
 *   - From the oldest date the bank returned when it over-returned history:
 *     rows older than the requested window were ingested too.
 *   - The summary is stamped on the connection (last_sie_sweep) so the UI can
 *     say "Vi matchade X av Y" and the review surface knows what to granska.
 *
 * Non-critical for the sync: a failure leaves the rows for manual review and
 * counts 0. It is never swept again (the sweep runs only when a sync imports
 * rows), so the failure is an error: those rows sit unhandled next to the
 * verifikat that already book them, which invites booking them twice.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import {
  runUnattendedReconciliationSweep,
  toSweepSummary,
} from '@/lib/reconciliation/unattended-sweep'

const errorLog = createLogger('bank-sync/post-sync-sweep')

export interface PostSyncSweepLog {
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
}

export interface PostSyncSweepInput {
  companyId: string
  userId: string
  connectionId: string
  ledgerAccounts: Array<string | null | undefined>
  fromDate: string
  toDate: string
  /** Oldest booking date the bank returned, when it said. */
  returnedMin: string | null
  log: PostSyncSweepLog
}

/** Returns the number of rows linked to existing verifikat. */
export async function sweepAfterOverlappingSync(
  supabase: SupabaseClient,
  input: PostSyncSweepInput,
): Promise<number> {
  const { companyId, userId, connectionId, toDate, log } = input
  const sweepFrom = input.returnedMin && input.returnedMin < input.fromDate ? input.returnedMin : input.fromDate
  const ledgerAccounts = Array.from(
    new Set(input.ledgerAccounts.filter((l): l is string => typeof l === 'string' && l.length > 0)),
  )
  try {
    const sweep = await runUnattendedReconciliationSweep(supabase, companyId, userId, {
      dateFrom: sweepFrom,
      dateTo: toDate,
      ledgerAccounts,
    })
    const { error: stampError } = await supabase
      .from('bank_connections')
      .update({ last_sie_sweep: toSweepSummary(sweep, { dateFrom: sweepFrom, dateTo: toDate }) })
      .eq('id', connectionId)
    if (stampError) errorLog.error('Post-sync reconciliation summary not stamped', { connectionId, companyId, code: stampError.code, message: stampError.message })
    if (sweep.applied > 0 || sweep.skippedBelowThreshold > 0) {
      log.info('Post-sync reconciliation linked imported rows to existing verifikat', {
        connectionId,
        applied: sweep.applied,
        skippedBelowThreshold: sweep.skippedBelowThreshold,
        accounts: sweep.accounts.map((a) => ({
          accountNumber: a.accountNumber,
          applied: a.applied,
          skippedBelowThreshold: a.skippedBelowThreshold,
        })),
      })
    }
    return sweep.applied
  } catch (sweepError) {
    errorLog.error('Post-sync reconciliation sweep failed', {
      connectionId,
      companyId,
      message: sweepError instanceof Error ? sweepError.message : String(sweepError),
    })
    return 0
  }
}
