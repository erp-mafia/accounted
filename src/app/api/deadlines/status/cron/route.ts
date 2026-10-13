import { NextResponse } from 'next/server'
import { updateDeadlineStatuses } from '@/lib/deadlines/status-engine'
import { withServiceCronContext } from '@/lib/api/with-cron-context'

/**
 * GET /api/deadlines/status/cron: daily 06:00 UTC.
 * Updates deadline statuses across all companies.
 */
export const GET = withServiceCronContext('cron.deadlines_status', async (_request, ctx) => {
  const supabase = ctx.supabase

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
