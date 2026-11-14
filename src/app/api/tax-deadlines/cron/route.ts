import { NextResponse } from 'next/server'
import {
  alignYearlyVatDeadlinesWithBooks,
  backfillMissingTaxDeadlines,
  generateNewYearDeadlines,
} from '@/lib/tax/deadline-generator'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { todayIsoStockholm } from '@/lib/dates/iso'

/** The limit these runs already had as the platform default, now declared: a scheduled route states its own (scripts/generate-crontabs.ts). */
export const maxDuration = 300

/**
 * No company is started this long into the run. The function limit is 300 s
 * (the platform default; this route sets none) and one company's
 * regeneration is a handful of database calls, so a minute is left for the
 * one in flight. The run of 2026-11-10 took 175 s: a rolling 183-day horizon
 * flags every company with a recurring obligation on the same night (next
 * about 2026-12-13), and 2 January regenerates all of them.
 */
const RUN_BUDGET_MS = 240_000

/**
 * The most the helårsmoms pass (alignYearlyVatDeadlinesWithBooks) may take,
 * after the repair pass and inside the run budget. It reads one period's
 * declaration per open helårsmoms period and takes the companies in a
 * different order every day, so a short pass still reaches every company in
 * a few nights.
 */
const EU_TRADE_PASS_BUDGET_MS = 60_000

/**
 * GET /api/tax-deadlines/cron: daily recovery plus annual horizon extension.
 *
 * Both passes stop starting companies at the time budget. A company not
 * reached keeps missing its rows, so the next run finds and repairs it; how
 * many were left is logged as an error, so a run that keeps falling behind
 * is seen instead of dying at the limit with nothing said.
 */
export const GET = withServiceCronContext('cron.tax_deadlines', async (_request, ctx) => {
  const supabase = ctx.supabase
  const isAnnualRun = todayIsoStockholm().slice(5) === '01-02'
  const deadline = ctx.startedAt + RUN_BUDGET_MS

  // Each step logs its own failure before rethrowing so a partial failure
  // names the failed step in the audit trail instead of surfacing as an
  // anonymous cron error.
  let annual = { usersProcessed: 0, totalCreated: 0, companiesNotReached: 0 }
  if (isAnnualRun) {
    try {
      annual = await generateNewYearDeadlines(supabase, { deadline })
    } catch (err) {
      ctx.log.error('new-year deadline generation failed', err as Error)
      throw err
    }
  }

  let recovery
  try {
    recovery = await backfillMissingTaxDeadlines(supabase, { deadline })
  } catch (err) {
    ctx.log.error('tax deadline backfill failed', err as Error)
    throw err
  }

  // Helårsmoms periods whose books now show EU trade with the setting off:
  // recorded, and their rows moved to the earlier date. Missing rows come
  // first: this pass only moves dates.
  let euTrade = { companiesChecked: 0, companiesMoved: 0, companiesNotReached: 0 }
  try {
    euTrade = await alignYearlyVatDeadlinesWithBooks(supabase, {
      deadline: Math.min(deadline, Date.now() + EU_TRADE_PASS_BUDGET_MS),
    })
  } catch (err) {
    // The repair above has committed; a pass that only moves dates earlier
    // must not turn the run into a failure or hide its summary.
    ctx.log.error('helårsmoms EU-trade pass failed', err as Error)
  }

  const totalCreated = annual.totalCreated + recovery.totalCreated
  // The repair pass is what the next run resumes from: a company the
  // new-year pass did not reach is one of the companies the repair finds.
  const companiesNotReached = recovery.companiesNotReached

  if (companiesNotReached > 0 || annual.companiesNotReached > 0) {
    ctx.log.error(
      'tax deadline generation stopped at its time budget; the companies left are repaired by the next run',
      new Error('tax deadline run out of time'),
      {
        companiesNotReached,
        newYearCompaniesNotReached: annual.companiesNotReached,
        companiesRepaired: recovery.companiesRepaired,
        companiesScanned: recovery.companiesScanned,
      },
    )
  }

  ctx.log.info('tax deadlines cron summary', {
    isAnnualRun,
    usersProcessed: annual.usersProcessed,
    companiesScanned: recovery.companiesScanned,
    companiesRepaired: recovery.companiesRepaired,
    companiesNotReached,
    totalCreated,
    euTradeCompaniesChecked: euTrade.companiesChecked,
    euTradeCompaniesMoved: euTrade.companiesMoved,
    euTradeCompaniesNotReached: euTrade.companiesNotReached,
  })

  return NextResponse.json({
    success: true,
    isAnnualRun,
    usersProcessed: annual.usersProcessed,
    companiesScanned: recovery.companiesScanned,
    companiesRepaired: recovery.companiesRepaired,
    companiesNotReached,
    totalCreated,
    euTradeCompaniesChecked: euTrade.companiesChecked,
    euTradeCompaniesMoved: euTrade.companiesMoved,
    euTradeCompaniesNotReached: euTrade.companiesNotReached,
  })
})
