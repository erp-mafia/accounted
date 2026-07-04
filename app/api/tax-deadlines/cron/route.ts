import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { generateNewYearDeadlines } from '@/lib/tax/deadline-generator'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/tax-deadlines/cron: annual on January 2nd 00:00.
 * Generates the next year's tax deadlines for every company.
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

  const supabase = createClient(supabaseUrl, supabaseServiceKey)
  const result = await generateNewYearDeadlines(supabase)

  ctx.log.info('tax deadlines cron summary', {
    usersProcessed: result.usersProcessed,
    totalCreated: result.totalCreated,
  })

  return NextResponse.json({
    success: true,
    usersProcessed: result.usersProcessed,
    totalCreated: result.totalCreated,
  })
})
