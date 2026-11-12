import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * GET /api/permissions/shadow-log/cleanup/cron: daily 02:15 UTC.
 *
 * Deletes permission_shadow_log rows older than 7 days: the window the
 * permission shadow (lib/permissions/shadow.ts) is read over. Retention is
 * declared in .compliance/ropa.yaml (id: permissions.shadow_log).
 */
const SHADOW_LOG_RETENTION_DAYS = 7

/** The limit these runs already had as the platform default, now declared: a scheduled route states its own (scripts/generate-crontabs.ts). */
export const maxDuration = 300

export const GET = withCronContext('cron.permission_shadow_log_cleanup', async (_request, ctx) => {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - SHADOW_LOG_RETENTION_DAYS)

  const { error, count } = await createServiceClient()
    .from('permission_shadow_log')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff.toISOString())
  if (error) {
    ctx.log.error('permission shadow log cleanup failed', error)
    return errorResponse(error, ctx.log, { requestId: ctx.requestId })
  }
  const deleted = count ?? 0
  ctx.log.info('permission shadow log cleanup summary', { deleted, cutoff: cutoff.toISOString() })
  return NextResponse.json({ success: true, deleted })
})
