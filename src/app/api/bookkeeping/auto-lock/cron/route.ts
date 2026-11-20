import { NextResponse } from 'next/server'
import { runBudget } from '@/lib/api/run-budget'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { autoLockTarget } from '@/lib/company/auto-lock'
import { updateCompanySettings } from '@/lib/company/settings-service'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { dbError } from '@/lib/errors/db-error'
import { throwOutcomeFailure } from '@/lib/operations/errors'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { filedVatPeriodsReopenedBy } from '@/lib/vat/filed-periods-reopened'

export const maxDuration = 300

/** No company is started after this: one company is a handful of database calls. */
const RUN_BUDGET_MS = 240_000

interface AutoLockRow {
  company_id: string
  auto_lock_period_days: number | null
  bookkeeping_locked_through: string | null
  /** The embedded company, in either PostgREST shape. */
  companies: { created_by: string } | Array<{ created_by: string }>
}

/**
 * GET /api/bookkeeping/auto-lock/cron, nightly at 01:40 UTC (02:40 or 03:40
 * in Sweden, the same calendar day in both).
 *
 * Makes "Automatisk låsning efter" (company_settings.auto_lock_period_days)
 * true: every live company whose lock date is behind the setting's floor gets
 * it moved there (lib/company/auto-lock.ts has the rule).
 *
 * The move goes through the settings service like any other lock date move,
 * so the audit log records it (as this job: the cron actor, no person) and
 * period.lock_date_changed fires, with via 'auto_lock' (lib/events/types.ts
 * says whose id the event carries when nobody acted).
 *
 * Idempotent: a second run finds every lock date at its floor, and the
 * service replaces only the lock date this run read, so a date somebody
 * saved since is never moved back and two runs at once cannot both move one
 * company. A company whose save fails (the database refuses to lock more
 * while an SIE import holds a period, for one) is counted and reported with
 * its reason, never stops the rest, and is tried again the next night.
 */
export const GET = withServiceCronContext('cron.bookkeeping_auto_lock', async (_request, ctx) => {
  const today = todayIsoStockholm()

  const rows = await fetchAllRows<AutoLockRow>(({ from, to }) =>
    ctx.supabase
      .from('company_settings')
      .select('company_id, auto_lock_period_days, bookkeeping_locked_through, companies!inner(archived_at, created_by)')
      .not('auto_lock_period_days', 'is', null)
      .is('companies.archived_at', null)
      .order('company_id', { ascending: true })
      .range(from, to),
  )

  const due = rows.flatMap((row) => {
    const lockDate = autoLockTarget(row, today)
    const company = Array.isArray(row.companies) ? row.companies[0] : row.companies
    return lockDate
      ? [{ companyId: row.company_id, createdBy: company.created_by, lockedThrough: row.bookkeeping_locked_through, lockDate }]
      : []
  })

  const budget = runBudget(ctx.startedAt, RUN_BUDGET_MS)
  let moved = 0
  let changedMeanwhile = 0
  let notReached = 0

  const summary = await ctx.forEach('company', due, async ({ companyId, createdBy, lockedThrough, lockDate }, itemCtx) => {
    if (!budget.allows()) {
      notReached++
      return
    }
    const outcome = await updateCompanySettings(
      { supabase: ctx.supabase, companyId, userId: createdBy, log: itemCtx.log.child({ companyId }) },
      { bookkeeping_locked_through: lockDate },
      {
        adminVerified: true,
        via: 'auto_lock',
        expectedLockDate: lockedThrough,
        findReopenedFiledVatPeriods: filedVatPeriodsReopenedBy,
      },
    )
    if (outcome.ok) {
      moved++
      return
    }
    // The lock date changed after it was read above: tomorrow's run decides again.
    if (outcome.code === 'CONFLICT') {
      changedMeanwhile++
      return
    }
    // forEach counts the throw; a database refusal keeps its SQLSTATE for the log.
    if (outcome.error instanceof Error) throw outcome.error
    if (outcome.error) throw dbError(outcome.error, 'Lock date not moved')
    throwOutcomeFailure(outcome)
  })

  if (notReached > 0) {
    ctx.log.error(
      'automatic lock stopped at its time budget; the companies left are locked by the next run',
      new Error('automatic lock ran out of time'),
      { notReached, due: due.length },
    )
  }

  return NextResponse.json({
    data: {
      date: today,
      companies_with_auto_lock: rows.length,
      moved,
      changed_meanwhile: changedMeanwhile,
      not_reached: notReached,
      failed: summary.failed,
      failures: summary.failures.map(({ index, error }) => ({ company_id: due[index].companyId, error })),
    },
  })
})
