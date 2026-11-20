import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  runUnattendedReconciliationSweep,
  toSweepSummary,
  type SieSweepSummary,
} from '@/lib/reconciliation/unattended-sweep'
import type { SIEJob } from './sie-job-contract'
import { runsSIEJobs } from './sie-jobs'

/**
 * The verifikat matcher run that follows a completed SIE import (issue #2835).
 *
 * WHY IT EXISTS. The two unattended sweeps fire when bank rows arrive into a
 * period that already holds imported verifikat (bank sync, bank file import).
 * Nothing fired for the opposite order: verifikat arriving into a period that
 * already holds unlinked bank rows. That is every replacement import (the undo
 * stornos the old batch and releases its bank rows to Att bokfora, then the new
 * batch posts the same bank events again), every undo followed by a fresh
 * import, and every first import into a company whose bank was connected
 * first. The user then sees "unbooked" rows whose bookkeeping already exists,
 * one click from a double booking. SIE carries no bank transaction ids, so
 * date, signed amount and account are all a re-imported verifikat can be
 * re-attached by: exactly what the matcher keys on.
 *
 * WHAT IT WRITES. Nothing of its own: it calls the same per-cash-account sweep
 * as the bank-side callers, with the same fixed rule. At or above 0.9
 * (auto_exact: same amount and date; auto_reference: same amount and an OCR or
 * reference hit within 90 days) the row is linked; the 0.75 to 0.89 band
 * (auto_date_range, auto_fuzzy) is persisted as a suggestion the user confirms.
 * The link is a write on the transaction side only, never on a journal entry.
 *
 * WHEN. After complete_sie_import_job, never before: while a batch holds its
 * period, guard_sie_held_bank_pointer refuses a bank link to it, so this
 * cannot be a phase of the job, and the import is already final when it runs.
 * It can therefore never fail or roll back the import: every error is caught
 * here. The receipt on sie_imports.bank_sweep (claim, then record) makes it
 * durable and single-flight: a function that dies mid-sweep leaves a stale
 * claim that runPendingSIEBankSweeps takes over from the worker cron, and the
 * sweep is idempotent because it only ever selects rows that are still
 * unlinked.
 */

const log = createLogger('sie-post-import-sweep')

/** How far back the cron looks for a completed import with no finished receipt. */
const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000

/** Claims claim_sie_import_bank_sweep grants one import (20260921230500). */
export const SIE_BANK_SWEEP_MAX_ATTEMPTS = 5

export type SIEBankSweepJob = Pick<
  SIEJob,
  'id' | 'company_id' | 'user_id' | 'execution_actor_id' | 'job_state' | 'job_kind'
> & {
  /** Read only for its sealed fiscal year, when the columns below are empty. */
  manifest?: SIEJob['manifest'] | null
  fiscal_year_start?: string | Date | null
  fiscal_year_end?: string | Date | null
  /** The receipt as the caller read it, before this claim: names the attempt a failure spends. */
  bank_sweep?: { state?: string; attempt?: number } | null
}

export interface SIEBankSweepReceipt extends SieSweepSummary {
  /** Why no matcher run was needed; absent when the sweep ran. */
  skipped?: 'no_unlinked_bank_rows' | 'no_fiscal_year'
}

/** PostgREST hands dates over as 'YYYY-MM-DD'; a direct pg client hands over a Date. */
export function isoDay(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  }
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null
}

function fiscalYearOf(job: SIEBankSweepJob): { start: string; end: string } | null {
  const input = (job.manifest as { input?: { fiscalYear?: { start?: unknown; end?: unknown } } } | null)?.input
  const start = isoDay(job.fiscal_year_start) ?? isoDay(input?.fiscalYear?.start)
  const end = isoDay(job.fiscal_year_end) ?? isoDay(input?.fiscalYear?.end)
  return start && end ? { start, end } : null
}

function emptyReceipt(
  skipped: NonNullable<SIEBankSweepReceipt['skipped']>,
  year: { start: string; end: string } | null,
): SIEBankSweepReceipt {
  return {
    auto_linked: 0,
    suggested: 0,
    unmatched: 0,
    errors: 0,
    date_from: year?.start ?? null,
    date_to: year?.end ?? null,
    ran_at: new Date().toISOString(),
    skipped,
  }
}

/**
 * Claim, sweep, record. Returns the receipt, or null when there was nothing to
 * do for this caller (not a completed import, already claimed elsewhere, or a
 * failure that leaves the claim in place for the cron to retry). Never throws.
 */
export async function sweepBankRowsAfterSIEImport(
  supabase: SupabaseClient,
  job: SIEBankSweepJob,
): Promise<SIEBankSweepReceipt | null> {
  if (job.job_state !== 'completed' || (job.job_kind ?? 'import') !== 'import') return null
  let claimed = false
  try {
    const claim = await supabase.rpc('claim_sie_import_bank_sweep', {
      p_company_id: job.company_id,
      p_import_id: job.id,
    })
    if (claim.error) throw new Error(claim.error.message)
    if (claim.data !== true) return null
    claimed = true

    const year = fiscalYearOf(job)
    let receipt: SIEBankSweepReceipt
    if (!year) {
      receipt = emptyReceipt('no_fiscal_year', null)
    } else {
      // Most imports land in a company with no unlinked bank rows at all
      // (SIE first, bank later). One HEAD count keeps those off the matcher.
      const { count, error } = await supabase
        .from('open_bank_rows')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', job.company_id)
        .gte('date', year.start)
        .lte('date', year.end)
      if (error) throw new Error(error.message)
      if (!count) {
        receipt = emptyReceipt('no_unlinked_bank_rows', year)
      } else {
        const result = await runUnattendedReconciliationSweep(
          supabase,
          job.company_id,
          job.execution_actor_id ?? job.user_id,
          { dateFrom: year.start, dateTo: year.end },
        )
        receipt = toSweepSummary(result, { dateFrom: year.start, dateTo: year.end })
      }
    }

    const recorded = await supabase.rpc('record_sie_import_bank_sweep', {
      p_company_id: job.company_id,
      p_import_id: job.id,
      p_summary: receipt,
    })
    if (recorded.error) {
      // The links and suggestions are already written; only the receipt is
      // missing, and the stale claim makes the cron run the (now mostly empty)
      // sweep again. Say so instead of letting it look unrun.
      log.warn('post-import bank sweep ran but its receipt was not recorded', {
        companyId: job.company_id,
        importId: job.id,
        message: recorded.error.message,
      })
    }
    if (receipt.auto_linked > 0 || receipt.suggested > 0 || receipt.errors > 0) {
      log.info('post-import bank sweep', {
        companyId: job.company_id,
        importId: job.id,
        autoLinked: receipt.auto_linked,
        suggested: receipt.suggested,
        unmatched: receipt.unmatched,
        errors: receipt.errors,
      })
    }
    return receipt
  } catch (err) {
    // The import is complete and stays complete, but its bank rows stay in
    // Att bokfora unmatched: an error, not a warning. A taken claim goes
    // stale and the cron retries it ten minutes later; its last attempt
    // leaves the receipt "running" for good, so that one says it is final.
    // A failure before the claim spent no attempt: the next caller claims.
    const attempt = claimed ? (job.bank_sweep?.attempt ?? 0) + 1 : null
    log.error('post-import bank sweep failed; the import itself is unaffected', err instanceof Error ? err : new Error(String(err)), {
      alert: true,
      companyId: job.company_id,
      importId: job.id,
      claimed,
      attempt,
      retried: !claimed || (attempt !== null && attempt < SIE_BANK_SWEEP_MAX_ATTEMPTS),
    })
    return null
  }
}

/**
 * The sealed manifest is the fallback source of the fiscal year (fiscalYearOf):
 * read it for one pending row whose year columns are empty. Null when that
 * read fails: the row keeps no receipt and the next cron run nominates it
 * again.
 */
async function withFiscalYearSource(
  supabase: SupabaseClient,
  row: SIEBankSweepJob,
): Promise<SIEBankSweepJob | null> {
  if (isoDay(row.fiscal_year_start) && isoDay(row.fiscal_year_end)) return row
  const { data, error } = await supabase
    .from('sie_imports')
    .select('manifest')
    .eq('id', row.id)
    .eq('company_id', row.company_id)
    .maybeSingle()
  if (error) {
    log.warn('pending post-import bank sweep could not read its manifest', {
      companyId: row.company_id,
      importId: row.id,
      message: error.message,
    })
    return null
  }
  return { ...row, manifest: (data as { manifest?: SIEJob['manifest'] | null } | null)?.manifest ?? null }
}

/**
 * Cron recovery: finish the sweep for recently completed imports that have no
 * finished receipt (the function died after completion, or the claim went
 * stale mid-sweep). The claim RPC decides who runs; this only nominates.
 */
export async function runPendingSIEBankSweeps(
  options: { supabase?: SupabaseClient; budgetMs?: number; limit?: number } = {},
): Promise<{ considered: number; swept: number }> {
  if (!runsSIEJobs()) return { considered: 0, swept: 0 }
  const deadline = Date.now() + Math.min(options.budgetMs ?? 240_000, 240_000) - 10_000
  let considered = 0
  let swept = 0
  try {
    const supabase = options.supabase ?? createServiceClientNoCookies()
    const since = new Date(Date.now() - PENDING_WINDOW_MS).toISOString()
    // The receipt filter runs here, not in the query: a day of completed
    // imports is a handful of rows, and a JSON path inside a PostgREST or()
    // is one more thing that can only fail in production. The listing runs
    // every minute and nearly every row it finds already holds a finished
    // receipt, so it leaves the manifest out: about 15 KB a row, detoasted
    // and serialised on each call, it made this the slowest SIE query in
    // production (122 ms mean, 6.3 s max). A pending row reads it below, and
    // only when its fiscal-year columns are empty.
    const { data, error } = await supabase
      .from('sie_imports')
      .select('id, company_id, user_id, execution_actor_id, job_state, job_kind, fiscal_year_start, fiscal_year_end, bank_sweep')
      .eq('job_state', 'completed')
      .eq('job_kind', 'import')
      .gte('imported_at', since)
      .order('imported_at')
      .limit(200)
    if (error) throw new Error(error.message)
    const pending = ((data ?? []) as Array<SIEBankSweepJob & { bank_sweep: { state?: string } | null }>)
      .filter((row) => !row.bank_sweep || row.bank_sweep.state === 'running')
      .slice(0, options.limit ?? 10)
    for (const row of pending) {
      if (Date.now() > deadline || !runsSIEJobs()) break
      considered++
      const job = await withFiscalYearSource(supabase, row)
      if (job && await sweepBankRowsAfterSIEImport(supabase, job)) swept++
    }
  } catch (err) {
    log.warn('pending post-import bank sweeps could not be listed', {
      message: err instanceof Error ? err.message : String(err),
    })
  }
  return { considered, swept }
}
