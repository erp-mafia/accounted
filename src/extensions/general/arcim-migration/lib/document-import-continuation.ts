/**
 * The server's half of the underlag run (crm#1581).
 *
 * The run is a chain of time-budgeted slices (import-documents.ts) that used
 * to move only while a browser tab asked for the next one: a 17 219-file
 * Fortnox run moved in six bursts over twenty hours, whenever its laptop was
 * awake, and a closed tab stopped it outright. The summary already kept the
 * cursor a run stopped at (document-import-run.ts); this worker, run every
 * minute by its cron, carries such a run on from that cursor.
 *
 * A slice here sweeps until the invocation's deadline, not for the tab's
 * 30 s: every slice first pays the provider's whole listing (about two
 * minutes for 17 000 Fortnox files), which a 30 s sweep spent four fifths of
 * its time on.
 *
 * One driver at a time. The worker takes a run the tab left silent past
 * DOCUMENT_IMPORT_RUN_STALL_MS, or one it drove itself, and the import route
 * refuses a tab while the server drives (documentImportDrivenByServer). Two
 * workers (overlapping cron runs) claim a run by compare-and-set on the
 * row's updated_at, which every write moves (update_updated_at_column), so
 * the loser sees zero rows and moves on. A tab that wakes up mid-claim is the
 * one race left: its upsert drops the worker's lease, the worker's next
 * compare-and-set finds nothing and stops. Neither duplicates a file: the
 * import's deterministic document id (uploadDocument idempotency_key) makes
 * two drivers converge on one row.
 *
 * The worker acts as the member whose tab drove the run's latest slice (the
 * row's user_id, kept by every write here): it continues what that member
 * asked for, and stops once they can no longer write in the company.
 */

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { ExecutionBudgetExceeded, withExecutionDeadline } from '@/lib/http/execution-budget'
import { FORTNOX_DOCUMENT_SCOPES_APPROVED } from '@/lib/providers/fortnox/oauth'
import { ProviderCallError } from '@/lib/providers/with-provider-call'
import {
  FortnoxDocumentScopesRequiredError,
  ProviderConnectionRefusedError,
  importProviderDocuments,
} from './import-documents'
import {
  DOCUMENT_IMPORT_RUN_KEY,
  DOCUMENT_IMPORT_SERVER_MAX_FAILURES,
  DOCUMENT_IMPORT_SERVER_WINDOW_MS,
  documentImportRunFacts,
  documentImportRunStillCurrent,
  documentImportServerMayClaim,
  foldDocumentImportSlice,
  markDocumentImportNeedsReconnect,
  parseDocumentImportRun,
  withoutServerHold,
  type DocumentImportRunFacts,
  type DocumentImportRunSummary,
} from './document-import-run'
import { whereSieImportInPlace } from '@/lib/bookkeeping/sie-import-in-place'

const log = createLogger('extensions/arcim-migration/document-import-continuation')

const EXTENSION_ID = 'arcim-migration'

/** The roles that may run the import themselves (the route refuses viewers). */
const WRITE_ROLES = new Set(['owner', 'admin', 'member'])

/**
 * Longer than the cron's whole invocation (maxDuration 800 s), so a worker
 * the platform ends lets go of its run on its own.
 */
export const DOCUMENT_IMPORT_LEASE_MS = 15 * 60_000

/**
 * A slice starts only with this much sweep left before the deadline. Every
 * slice pays the provider's whole listing first, about two minutes for a
 * 17 000-file Fortnox company, so a slice is worth starting only when it can
 * sweep for a good while after it.
 */
const MIN_SLICE_START_MS = 4 * 60_000

/** Waits after the 1st, 2nd, 3rd and 4th failed attempt in a row; the 5th stops the server's tries. */
const RETRY_BACKOFF_MS: readonly number[] = [5, 10, 20, 40].map((minutes) => minutes * 60_000)

const CANDIDATE_LIMIT = 50

/** The failure counts the server still tries again at (0 to MAX - 1), as stored text. */
const STILL_TRYING = Array.from({ length: DOCUMENT_IMPORT_SERVER_MAX_FAILURES }, (_, n) => String(n))

interface RunRow {
  id: string
  company_id: string
  user_id: string
  value: unknown
  updated_at: string
}

export interface DocumentImportContinuationResult {
  /** Unfinished runs the server could take now. */
  eligible: number
  claimed: number
  slices: number
  completed: number
  /** Runs the provider refused: they wait for a reconnect. */
  reconnect: number
  /** Attempts that failed and wait to be tried again. */
  failed: number
  /** Attempts the platform ended mid-slice, counted from the lease they left behind. */
  interrupted: number
  /** Runs the server let go of for good (outdated, no connection, no writer). */
  released: number
}

type DriverContext =
  | { ok: true; userId: string; consentId: string; facts: DocumentImportRunFacts }
  | { ok: false; reason: 'company_archived' | 'driver_not_a_writer' | 'connection_unknown' | 'run_outdated' }

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * Write the summary only if the row is still the version read: its
 * updated_at moves on every write. The new version, or null when someone
 * else wrote first.
 */
async function compareAndSet(
  supabase: SupabaseClient,
  rowId: string,
  version: string,
  value: DocumentImportRunSummary,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('extension_data')
    .update({ value })
    .eq('id', rowId)
    .eq('updated_at', version)
    .select('updated_at')
  if (error) throw new Error(`underlag run write failed: ${error.message}`)
  const rows = (data ?? []) as { updated_at: string }[]
  return rows[0]?.updated_at ?? null
}

/** Who the worker acts as and which connection it reads, or why it may not continue. */
async function driverContext(
  supabase: SupabaseClient,
  row: RunRow,
  run: DocumentImportRunSummary,
): Promise<DriverContext> {
  const [company, member, consents, ledger] = await Promise.all([
    supabase.from('companies').select('archived_at').eq('id', row.company_id).maybeSingle(),
    supabase
      .from('company_members')
      .select('role')
      .eq('company_id', row.company_id)
      .eq('user_id', row.user_id)
      .maybeSingle(),
    supabase
      .from('provider_consents')
      .select('id, provider, created_at')
      .eq('company_id', row.company_id)
      .eq('status', 1),
    whereSieImportInPlace(
      supabase
        .from('sie_imports')
        .select('imported_at, created_at')
        .eq('company_id', row.company_id),
    )
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  for (const result of [company, member, consents, ledger]) {
    if (result.error) throw new Error(`underlag run context read failed: ${result.error.message}`)
  }

  const companyRow = company.data as { archived_at: string | null } | null
  if (!companyRow || companyRow.archived_at) return { ok: false, reason: 'company_archived' }
  const role = (member.data as { role: string } | null)?.role
  if (!role || !WRITE_ROLES.has(role)) return { ok: false, reason: 'driver_not_a_writer' }

  const accepted = ((consents.data ?? []) as { id: string; provider: string; created_at: string | null }[]).map(
    (consent) => ({ id: consent.id, provider: consent.provider, createdAt: consent.created_at }),
  )
  const facts = documentImportRunFacts(
    run,
    accepted,
    ledger.data as { imported_at: string | null; created_at: string | null } | null,
  )
  if (!facts.connection) return { ok: false, reason: 'connection_unknown' }
  if (!documentImportRunStillCurrent(run, facts)) return { ok: false, reason: 'run_outdated' }
  return { ok: true, userId: row.user_id, consentId: facts.connection.id, facts }
}

/** The provider refused the connection itself: the run waits for the member to reconnect. */
function providerRefusal(error: unknown): boolean {
  return (
    error instanceof ProviderConnectionRefusedError ||
    (error instanceof ProviderCallError && error.code === 'PROVIDER_AUTH_EXPIRED') ||
    (error instanceof FortnoxDocumentScopesRequiredError && FORTNOX_DOCUMENT_SCOPES_APPROVED)
  )
}

export interface DocumentImportContinuationOptions {
  supabase: SupabaseClient
  /**
   * The sweep starts no file after this, and no slice starts with less than
   * MIN_SLICE_START_MS left before it. A slice sweeps right up to it rather
   * than for the tab's 30 s, so its listing is paid once per invocation.
   */
  deadline: number
  /** Bounds a slice that overruns (a file in flight at the deadline, the writes after it). */
  hardDeadline?: number
  now?: () => number
  importDocuments?: typeof importProviderDocuments
  workerId?: string
}

interface Worker {
  supabase: SupabaseClient
  deadline: number
  hardDeadline: number
  now: () => number
  importDocuments: typeof importProviderDocuments
  id: string
  outcome: DocumentImportContinuationResult
}

/** Carry on every unfinished underlag run the server may take, until the deadline. */
export async function runDocumentImportContinuation(
  options: DocumentImportContinuationOptions,
): Promise<DocumentImportContinuationResult> {
  const worker: Worker = {
    supabase: options.supabase,
    deadline: options.deadline,
    hardDeadline: options.hardDeadline ?? options.deadline + 60_000,
    now: options.now ?? Date.now,
    importDocuments: options.importDocuments ?? importProviderDocuments,
    id: options.workerId ?? randomUUID(),
    outcome: { eligible: 0, claimed: 0, slices: 0, completed: 0, reconnect: 0, failed: 0, interrupted: 0, released: 0 },
  }
  const { supabase, deadline, now, outcome } = worker

  // Unfinished runs written to within the window; the row's updated_at is
  // never older than the summary's own, so this only narrows. Runs waiting
  // for a reconnect or given up on are left out here, not after the limit:
  // fifty of them would otherwise crowd out every run the server could take.
  const { data, error } = await supabase
    .from('extension_data')
    .select('id, company_id, user_id, value, updated_at')
    .eq('extension_id', EXTENSION_ID)
    .eq('key', DOCUMENT_IMPORT_RUN_KEY)
    .eq('value->>complete', 'false')
    .or('value->>needsReconnect.is.null,value->>needsReconnect.eq.false')
    .or(`value->>serverFailures.is.null,value->>serverFailures.in.(${STILL_TRYING.join(',')})`)
    .gte('updated_at', iso(now() - DOCUMENT_IMPORT_SERVER_WINDOW_MS))
    .order('updated_at', { ascending: true })
    .limit(CANDIDATE_LIMIT)
  if (error) throw new Error(`underlag runs could not be listed: ${error.message}`)

  for (const row of (data ?? []) as RunRow[]) {
    if (deadline - now() < MIN_SLICE_START_MS) break
    const run = parseDocumentImportRun(row.value)
    if (!run || !documentImportServerMayClaim(run, now())) continue
    outcome.eligible++
    try {
      await continueRun(worker, row, run)
    } catch (runError) {
      // A read or write the database refused: this run waits for the next
      // cron run, the others still get theirs.
      log.error('underlag run could not be continued on the server', runError as Error, {
        companyId: row.company_id,
      })
    }
  }

  return outcome
}

async function continueRun(worker: Worker, row: RunRow, run: DocumentImportRunSummary): Promise<void> {
  const { supabase, deadline, hardDeadline, now, outcome } = worker
  const context = await driverContext(supabase, row, run)
  if (!context.ok) {
    // For good: none of these heals by waiting. Whoever starts the run
    // again (and so becomes its driver) gives the server a new one.
    log.info('underlag run not continued on the server', { companyId: row.company_id, reason: context.reason })
    const released = await compareAndSet(supabase, row.id, row.updated_at, {
      ...withoutServerHold(run),
      serverFailures: DOCUMENT_IMPORT_SERVER_MAX_FAILURES,
    })
    if (released) outcome.released++
    return
  }

  // A lease still on the summary (lapsed, or the run would not be claimable)
  // was never let go: every way out of the loop below drops it, so the worker
  // that took it was ended by the platform in the middle of a slice. A slice
  // writes its cursor only when it ends, so that attempt left nothing else
  // behind and nothing counted it: a run whose slice never finishes inside
  // the invocation started over every fifteen minutes for the whole fourteen
  // days. It is counted here as a failed attempt, by the claim that finds it;
  // a folded slice starts the count over (foldDocumentImportSlice), so only
  // attempts in a row that folded nothing reach the cap.
  const interrupted = run.lease !== undefined
  const failures = (run.serverFailures ?? 0) + (interrupted ? 1 : 0)
  if (interrupted) outcome.interrupted++
  if (interrupted && failures >= DOCUMENT_IMPORT_SERVER_MAX_FAILURES) {
    // Given up on for good: the page shows the run as stopped and offers to
    // carry on from the cursor. Reported once, here, because the attempts
    // that were ended could not report themselves.
    const stopped = await compareAndSet(supabase, row.id, row.updated_at, {
      ...withoutServerHold(run),
      serverFailures: DOCUMENT_IMPORT_SERVER_MAX_FAILURES,
    })
    if (stopped) {
      outcome.released++
      log.error('underlag run stopped on the server: its attempts kept being ended mid-slice', undefined, {
        companyId: row.company_id,
        provider: run.provider,
        failures,
        cursor: run.nextCursor,
        scanned: run.scanned,
        total: run.total,
      })
    }
    return
  }

  const lease = () => ({ owner: worker.id, until: iso(now() + DOCUMENT_IMPORT_LEASE_MS) })
  let current: DocumentImportRunSummary = {
    ...run,
    lease: lease(),
    ...(interrupted ? { serverFailures: failures } : {}),
  }
  const claimed = await compareAndSet(supabase, row.id, row.updated_at, current)
  if (!claimed) return
  let version: string = claimed
  let holding = true
  let contextStale = false
  let contextCheckedAt = now()
  // This claim stored at least one slice: the run moved.
  let folded = false
  outcome.claimed++
  log.info('underlag run continued on the server', {
    companyId: row.company_id,
    provider: run.provider,
    scanned: run.scanned,
    total: run.total,
    ...(interrupted ? { interruptedAttempts: failures } : {}),
  })

  try {
    while (deadline - now() >= MIN_SLICE_START_MS) {
      const cursor = current.nextCursor
      const result = await withExecutionDeadline(hardDeadline, 'underlag-continuation', () =>
        worker.importDocuments({
          supabase,
          companyId: row.company_id,
          userId: context.userId,
          consentId: context.consentId,
          cursor,
          // The sweep runs to the deadline, not for a fixed budget.
          timeBudgetMs: deadline - now(),
          sweepDeadline: deadline,
          shouldContinue: async () => {
            if (now() - contextCheckedAt < 60_000) return true
            contextCheckedAt = now()
            const { data, error } = await supabase
              .from('extension_data')
              .select('updated_at')
              .eq('id', row.id)
              .maybeSingle()
            if (error) throw new Error(`underlag run freshness read failed: ${error.message}`)
            if ((data as { updated_at?: string } | null)?.updated_at !== version) {
              contextStale = true
              return false
            }
            const refreshed = await driverContext(supabase, row, current)
            if (!refreshed.ok || refreshed.consentId !== context.consentId) {
              contextStale = true
              return false
            }
            return true
          },
        }),
      )
      if (contextStale) break
      outcome.slices++
      // The sweep always moves past at least one file; a slice that says it
      // stopped short without moving would have the server spin on it.
      if (result.partial && (!result.nextCursor || (cursor !== null && result.nextCursor <= cursor))) {
        throw new Error('UNDERLAG_RUN_NOT_ADVANCING')
      }
      const summary = foldDocumentImportSlice(current, result, cursor, iso(now()), {
        driver: 'server',
        consentId: context.consentId,
        run: current.startedAt,
      })
      // `current` is the version this worker holds, so its next slice always
      // continues it; a null fold would mean the run is not this one.
      if (!summary) break
      const next: DocumentImportRunSummary = summary.complete ? summary : { ...summary, lease: lease() }
      const written = await compareAndSet(supabase, row.id, version, next)
      if (!written) {
        // A tab wrote in between: it drives the run now.
        holding = false
        break
      }
      version = written
      current = next
      folded = true
      if (next.complete) {
        holding = false
        outcome.completed++
        log.info('underlag run finished on the server', {
          companyId: row.company_id,
          total: next.total,
          linked: next.linked,
          skipped: next.skipped,
          unmatched: next.unmatched,
          failed: next.failed,
          locked: next.locked,
        })
        break
      }
    }
  } catch (sliceError) {
    if (sliceError instanceof ExecutionBudgetExceeded && folded) {
      // Out of time after a slice was stored is a deferral: the next cron
      // run takes it on from the new cursor. Out of time with nothing stored
      // falls through to the failed attempt below, as in the register
      // worker: a slice that never ends inside the invocation otherwise
      // repeated, uncounted, for the whole fourteen days.
      log.info('underlag run deferred to the next server run', { companyId: row.company_id })
    } else if (sliceError instanceof ProviderCallError && sliceError.code === 'PROVIDER_LICENSE_MISSING') {
      holding = false
      const released = await compareAndSet(supabase, row.id, version, {
        ...withoutServerHold(current),
        serverFailures: DOCUMENT_IMPORT_SERVER_MAX_FAILURES,
      })
      if (released) outcome.released++
      log.info('underlag run on the server stopped: the Fortnox license is missing', {
        companyId: row.company_id,
      })
    } else if (providerRefusal(sliceError)) {
      holding = false
      const marked = markDocumentImportNeedsReconnect(current, current.provider, current.nextCursor, iso(now()))
      if (marked && (await compareAndSet(supabase, row.id, version, marked))) outcome.reconnect++
      log.warn('underlag run on the server stopped: the provider refused the connection', {
        companyId: row.company_id,
        provider: current.provider,
      })
    } else {
      holding = false
      const failures = (current.serverFailures ?? 0) + 1
      const retryInMs = RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length) - 1]
      outcome.failed++
      log.error('underlag run on the server failed', sliceError as Error, {
        companyId: row.company_id,
        failures,
        cursor: current.nextCursor,
      })
      await compareAndSet(supabase, row.id, version, {
        ...withoutServerHold(current),
        serverFailures: failures,
        serverRetryAt: iso(now() + retryInMs),
      })
    }
  } finally {
    if (holding) {
      // Let go so the next cron run takes it at once, not after the lease.
      const { lease: _lease, ...released } = current
      await compareAndSet(supabase, row.id, version, released).catch((releaseError: unknown) =>
        log.warn('underlag run lease not released', {
          companyId: row.company_id,
          reason: releaseError instanceof Error ? releaseError.message : 'unknown',
        }),
      )
    }
  }
}
