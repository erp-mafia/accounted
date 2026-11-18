/**
 * The daily retry of consents nobody ended (#97). When a connection is
 * removed and the bank does not end its consent, the consent stays named on
 * the removed row (consent_attempt.unended_consent_id), and the company's
 * next connect attempt ends it first (releaseHeldConsents in ./service.ts).
 * A company that never comes back would keep it live until it expires, and
 * Connect counts it as the company's one bank connection. Once a day this asks again for every such row,
 * through the same endUnendedConsent the connect path uses:
 *
 *   - ended now, or already gone (ended earlier under the revocation claim,
 *     or over or unknown at the bank): the id is cleared from the row;
 *   - refused or unanswered: the id stays and the refusal is on the
 *     revocation claim (bank_session_revocations, outcome 'failed'), as on
 *     the connect path; the next run asks again;
 *   - busy (another call holds the claim, or a live row holds the consent):
 *     the id stays for the next run.
 *
 * Unattended: the party is the one an unattended read sends, the number the
 * consent was created with or else the connection owner's on file. At most
 * UNENDED_PER_RUN rows a run, UNENDED_CONCURRENCY at a time, none started
 * past UNENDED_TIME_BUDGET_MS. When more rows are held than one run takes,
 * the run starts at a window that moves every day, so rows the bank keeps
 * refusing never starve the others. One row that throws is counted and
 * logged, never the run's failure. Without a connector key nothing can be
 * asked: the run answers skipped.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { OPEN_PAYMENTS_AGGREGATOR } from '@/lib/bank-sync/aggregator'
import { mapWithConcurrency } from '@/lib/concurrency'
import type { Logger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getBankFeedConnect } from './connect'
import { endUnendedConsent, type UnendedConsentRow } from './service'

/** Rows asked in one run; the rest wait for a later day's window. */
export const UNENDED_PER_RUN = 50
/** Consents ended in parallel. */
export const UNENDED_CONCURRENCY = 4
/** No row is started past this; what is left is asked in a later run. */
export const UNENDED_TIME_BUDGET_MS = 230_000
/** The most held rows one run reads: far above any real backlog, a bound on a runaway one. */
export const UNENDED_MAX_READ = 5_000
const DAY_MS = 24 * 60 * 60 * 1000

type HeldRow = UnendedConsentRow & { company_id: string; user_id: string }

export type UnendedConsentCronResult =
  | { skipped: true; reason: 'no_connector' }
  | {
      skipped: false
      /** Removed connections still naming a consent the bank did not end. */
      held: number
      /** Rows asked this run. */
      attempted: number
      /** Ended at the bank now; cleared from the row. */
      ended: number
      /** Ended earlier or no longer at the bank; cleared from the row. */
      alreadyEnded: number
      /** The bank, Connect or the claim did not end it; kept for the next run. */
      kept: number
      /** Another call held the claim; kept for the next run. */
      busy: number
      /** The row threw; kept for the next run. */
      errored: number
      /** Held rows not asked this run: past the per-run cap or the time budget. */
      deferred: number
    }

/** This run's rows: UNENDED_PER_RUN of them, from a window that moves one batch a day. */
export function unendedBatch<T>(held: readonly T[], now: number, perRun = UNENDED_PER_RUN): T[] {
  if (held.length <= perRun) return [...held]
  const start = (Math.floor(now / DAY_MS) * perRun) % held.length
  return [...held.slice(start), ...held.slice(0, start)].slice(0, perRun)
}

export async function runUnendedConsentCron(
  supabase: SupabaseClient,
  log: Logger,
  options: { now?: number } = {},
): Promise<UnendedConsentCronResult> {
  const connect = getBankFeedConnect()
  if (!connect) return { skipped: true, reason: 'no_connector' }

  const held = await fetchAllRows<HeldRow>(
    ({ from, to }) =>
      supabase
        .from('bank_connections')
        .select('id, company_id, user_id, bic, affiliated_aspsp_id, psu_type, consent_attempt')
        .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
        .eq('status', 'revoked')
        .not('consent_attempt->>unended_consent_id', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
    { maxRows: UNENDED_MAX_READ },
  )
  const batch = unendedBatch(held, options.now ?? Date.now())
  const result = { skipped: false as const, held: held.length, attempted: 0, ended: 0, alreadyEnded: 0, kept: 0, busy: 0, errored: 0, deferred: held.length - batch.length }

  const startedRun = Date.now()
  await mapWithConcurrency(batch, UNENDED_CONCURRENCY, async (row) => {
    if (Date.now() - startedRun > UNENDED_TIME_BUDGET_MS) {
      result.deferred++
      return
    }
    result.attempted++
    try {
      const outcome = await endUnendedConsent({ supabase, companyId: row.company_id, userId: row.user_id, log }, connect, row)
      if (outcome === 'ended') result.ended++
      else if (outcome === 'already_ended') result.alreadyEnded++
      else if (outcome === 'busy') result.busy++
      else if (outcome === 'failed') result.kept++
    } catch (error) {
      result.errored++
      log.error('unended bank consent retry threw', { connectionId: row.id, message: error instanceof Error ? error.message : String(error) })
    }
  })
  return result
}
