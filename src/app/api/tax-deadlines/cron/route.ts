import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import {
  backfillMissingTaxDeadlines,
  generateNewYearDeadlines,
} from '@/lib/tax/deadline-generator'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/tax-deadlines/cron: daily recovery plus annual horizon extension.
 */
export const GET = withCronContext('cron.tax_deadlines', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)
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
