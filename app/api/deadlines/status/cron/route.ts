import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { updateDeadlineStatuses } from '@/lib/deadlines/status-engine'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/deadlines/status/cron: daily 06:00 UTC.
 * Updates deadline statuses across all companies.
 */
export const GET = withCronContext('cron.deadlines_status', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const result = await updateDeadlineStatuses(supabase)

  ctx.log.info('deadline status cron summary', {
    updated: result.updated,
    newlyOverdue: result.newlyOverdue,
    newlyActionNeeded: result.newlyActionNeeded,
  })

  return NextResponse.json({
    success: true,
    updated: result.updated,
    newlyOverdue: result.newlyOverdue,
    newlyActionNeeded: result.newlyActionNeeded,
  })
})
