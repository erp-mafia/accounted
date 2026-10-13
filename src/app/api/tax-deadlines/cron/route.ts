import { NextResponse } from 'next/server'
import {
  backfillMissingTaxDeadlines,
  generateNewYearDeadlines,
} from '@/lib/tax/deadline-generator'
import { withServiceCronContext } from '@/lib/api/with-cron-context'

/**
 * GET /api/tax-deadlines/cron: daily recovery plus annual horizon extension.
 */
export const GET = withServiceCronContext('cron.tax_deadlines', async (_request, ctx) => {
  const supabase = ctx.supabase
  const now = new Date()
  const isAnnualRun = now.getUTCMonth() === 0 && now.getUTCDate() === 2

  // Each step logs its own failure before rethrowing so a partial failure
  // names the failed step in the audit trail instead of surfacing as an
  // anonymous cron error.
  let annual = { usersProcessed: 0, totalCreated: 0 }
  if (isAnnualRun) {
    try {
      annual = await generateNewYearDeadlines(supabase)
    } catch (err) {
      ctx.log.error('new-year deadline generation failed', err as Error)
      throw err
    }
  }

  let recovery
  try {
    recovery = await backfillMissingTaxDeadlines(supabase)
  } catch (err) {
    ctx.log.error('tax deadline backfill failed', err as Error)
    throw err
  }

  const totalCreated = annual.totalCreated + recovery.totalCreated

  ctx.log.info('tax deadlines cron summary', {
    isAnnualRun,
    usersProcessed: annual.usersProcessed,
    companiesScanned: recovery.companiesScanned,
    companiesRepaired: recovery.companiesRepaired,
    totalCreated,
  })

  return NextResponse.json({
    success: true,
    isAnnualRun,
    usersProcessed: annual.usersProcessed,
    companiesScanned: recovery.companiesScanned,
    companiesRepaired: recovery.companiesRepaired,
    totalCreated,
  })
})
