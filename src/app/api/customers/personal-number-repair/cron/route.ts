import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { repairIndividualOrgNumbers } from '@/lib/customers/org-number-repair'

// The personnummer repair of
// scripts/repair-customer-personal-number-in-org-number.ts on a schedule, for
// a database that upgrades with such rows: they are repaired without an
// operator. Scheduled on Docker only (EXTRA_JOBS in
// scripts/generate-crontabs.ts). Where the check
// customers_individual_no_org_number is validated no such row can exist, so
// the hosted schedule (vercel.json) does not list this route.
export const maxDuration = 300
// No row is written after this; one write and its audit row finish well
// inside the rest, and the next run carries on where this one stopped.
const RUN_BUDGET_MS = 200_000

/**
 * The run that reports rows it could not write as an error: the one that
 * starts in the first five minutes after 06:00 UTC. The cron runs every five
 * minutes (docker/crontab.self-hosted), so that is one run a
 * day; the other 287 say it as a warning. Nothing here keeps state between
 * runs (no table for a one-off), so the gate is the clock: a row that keeps
 * failing reaches the error tracker once a day, not 288 times. A new failure
 * waits for the next 06:00 to be reported.
 */
const REPORT_HOUR_UTC = 6
const RUN_INTERVAL_MS = 5 * 60_000

function isDailyReportRun(startedAt: number): boolean {
  const at = new Date(startedAt)
  const intoHour = at.getTime() - Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours())
  return at.getUTCHours() === REPORT_HOUR_UTC && intoHour < RUN_INTERVAL_MS
}

export const GET = withServiceCronContext('cron.customer_personal_number_repair', async (_request, ctx) => {
  const run = await repairIndividualOrgNumbers(ctx.supabase, {
    apply: true,
    deadline: ctx.startedAt + RUN_BUDGET_MS,
    actorLabel: 'cron customer-personal-number-repair',
  })
  ctx.log.info('customer personal number repair run finished', run)
  // Rows the run decided to write and could not. They were only a count in
  // the info line above, which reaches nobody, while the route kept trying
  // the same rows every five minutes. Codes and counts only, as the lib
  // keeps them: a message could quote a row. An error once a day
  // (isDailyReportRun), a warning on every other run.
  const unwritten = Object.values(run.failed).reduce((sum, count) => sum + count, 0)
  if (unwritten > 0) {
    const details = { unwritten, failedByCode: run.failed, written: run.written, counts: run.counts }
    const message = 'customer personal number repair could not write some rows'
    if (isDailyReportRun(ctx.startedAt)) ctx.log.error(message, undefined, details)
    else ctx.log.warn(message, details)
  }
  // The last written row has no audit row: fail the run so it is seen.
  if (run.stopped === 'audit_failed') {
    throw new Error(`audit_log insert failed (${run.auditError}) after ${run.written} written`)
  }
  return NextResponse.json({ data: run })
})
