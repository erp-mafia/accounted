import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import type { Logger } from '@/lib/logger'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isMissingRpcSignature } from '@/lib/bookkeeping/actor-rpc'

export const maxDuration = 60

/**
 * Stop starting new work after this long. One call started at the last moment
 * may run until the 30 s statement timeout PostgREST sets for the service
 * role (pre_request_statement_timeout), so budget plus one call must fit
 * maxDuration: 25 + 30 = 55 s. At 40 s it did not (40 + 30 = 70 s; a run of
 * 48.7 s was seen in production).
 */
const TIME_BUDGET_MS = 25_000
/** Companies read per pass; the loop asks again until the budget is spent. */
const BATCH = 200
/**
 * Above this many verifikat a build takes over a second (about 2.5 s for
 * 60 000), and the company's postings wait for it: such companies are built
 * between midnight and 05:00 Stockholm time only.
 */
const LARGE_COMPANY_ENTRIES = 20_000
const NIGHT_END_HOUR = 5

/** lock_not_available: the company's lock wait gave up after its 2 s lock_timeout. */
const LOCK_NOT_AVAILABLE = '55P03'

/**
 * A lock wait that gave up (the company is busy with an import) is the one
 * failure the next run fixes by itself: a warning. Any other failure comes
 * back the same way every ten minutes, so it is an error a person must look
 * at, not a warning nobody reads (accounted#115).
 */
function logSkipped(
  log: Logger,
  step: 'build' | 'compaction',
  companyId: string,
  error: { code?: string; message?: string },
  table: 'ledger_account_days' | 'ledger_tagset_days' = 'ledger_account_days',
): void {
  if (error.code === LOCK_NOT_AVAILABLE) {
    log.warn(`${table} ${step} skipped`, { companyId, code: error.code })
  } else {
    log.error(`${table} ${step} failed`, { companyId, code: error.code ?? null, reason: error.message ?? null })
  }
}

/** The hour in Stockholm, 0-23. */
function stockholmHour(now: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: 'numeric', hourCycle: 'h23' }).format(now))
}

// Keeps ledger_account_days (migration 20261023093900) and ledger_tagset_days
// (20261101121500) compact and complete.
//
// Builds the companies that existed before it: until a company is built its
// reports keep the line-level path, so this only makes them fast, never
// right. One company per build_ledger_account_days call, each its own
// transaction, smallest first. A company's postings wait for its build, so a
// large one is built at night only. New companies are built from the start.
//
// Then folds the slot rows writers left (each backend adds to its own row so
// postings never queue on each other) into one row per key, so reports read
// one row per account and day. A company busy with an import gives up its
// lock wait after 2 s and is retried on the next run; any other failure is
// retried too, but logged as an error.
export const GET = withCronContext('cron.ledger_account_days_build', async (_request, ctx) => {
  const supabase = createServiceClientNoCookies()
  const started = Date.now()
  let built = 0
  let skipped = 0
  let deferred = 0
  const failed = new Set<string>()
  const night = stockholmHour(new Date()) < NIGHT_END_HOUR

  building: while (Date.now() - started < TIME_BUDGET_MS) {
    const { data: pending, error } = await supabase.rpc('ledger_account_days_pending', { p_limit: BATCH + failed.size })
    if (error) throw error
    const rows = ((pending ?? []) as Array<{ company_id: string; entry_count: number }>).filter((row) => !failed.has(row.company_id))
    if (rows.length === 0) break

    for (const { company_id: companyId, entry_count: entryCount } of rows) {
      if (Date.now() - started >= TIME_BUDGET_MS) break
      if (!night && Number(entryCount) > LARGE_COMPANY_ENTRIES) {
        // Smallest first: every company after this one is large too.
        deferred = rows.length - rows.findIndex((row) => row.company_id === companyId)
        break building
      }
      const { error: buildError } = await supabase.rpc('build_ledger_account_days', { p_company_id: companyId })
      if (buildError) {
        failed.add(companyId)
        skipped++
        logSkipped(ctx.log, 'build', companyId, buildError)
        continue
      }
      built++
    }
  }

  let compacted = 0
  while (Date.now() - started < TIME_BUDGET_MS) {
    const { data: unfolded, error } = await supabase.rpc('ledger_account_days_unfolded', { p_limit: BATCH + failed.size })
    if (error) throw error
    const ids = ((unfolded ?? []) as string[]).filter((id) => !failed.has(id))
    if (ids.length === 0) break

    for (const companyId of ids) {
      if (Date.now() - started >= TIME_BUDGET_MS) break
      const { error: compactError } = await supabase.rpc('compact_ledger_account_days', { p_company_id: companyId })
      if (compactError) {
        failed.add(companyId)
        skipped++
        logSkipped(ctx.log, 'compaction', companyId, compactError)
        continue
      }
      compacted++
    }
  }

  // The tag set summary (migration 20261101121500, the dimension cross
  // report): each company listed before it existed is rebuilt once from its
  // tagged verifikat (a company without tags is instant, so no night rule),
  // then its slot rows are folded like the others. Code ships before CI
  // applies the migration; until then the listing RPCs are missing and this
  // part waits for the next run.
  let tagsetsBuilt = 0
  let tagsetsCompacted = 0
  const tagsetSteps = [
    { list: 'ledger_tagset_days_pending', work: 'build_ledger_tagset_days', name: 'build' },
    { list: 'ledger_tagset_days_unfolded', work: 'compact_ledger_tagset_days', name: 'compaction' },
  ] as const
  tagsets: for (const step of tagsetSteps) {
    while (Date.now() - started < TIME_BUDGET_MS) {
      const { data, error } = await supabase.rpc(step.list, { p_limit: BATCH + failed.size })
      if (error) {
        if (isMissingRpcSignature(error)) break tagsets
        throw error
      }
      const ids = ((data ?? []) as string[]).filter((id) => !failed.has(id))
      if (ids.length === 0) break

      for (const companyId of ids) {
        if (Date.now() - started >= TIME_BUDGET_MS) break
        const { error: workError } = await supabase.rpc(step.work, { p_company_id: companyId })
        if (workError) {
          failed.add(companyId)
          skipped++
          logSkipped(ctx.log, step.name, companyId, workError, 'ledger_tagset_days')
          continue
        }
        if (step.work === 'build_ledger_tagset_days') tagsetsBuilt++
        else tagsetsCompacted++
      }
    }
  }

  ctx.log.info('ledger_account_days build run', {
    built, compacted, skipped, deferred, tagsetsBuilt, tagsetsCompacted, durationMs: Date.now() - started,
  })
  return NextResponse.json({
    data: { built, compacted, skipped, deferred, tagsets_built: tagsetsBuilt, tagsets_compacted: tagsetsCompacted },
  })
})
