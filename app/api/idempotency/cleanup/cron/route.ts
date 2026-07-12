import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { cleanupExpiredIdempotencyKeys } from '@/lib/api/idempotency'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * GET /api/idempotency/cleanup/cron: hourly.
 * Sweeps idempotency_keys past their 24h TTL.
 */
export const GET = withCronContext('cron.idempotency_cleanup', async (_request, ctx) => {
  try {
    const supabase = await createServiceClient()
    const deleted = await cleanupExpiredIdempotencyKeys(supabase)
    ctx.log.info('idempotency cleanup summary', { deleted })
    return NextResponse.json({ success: true, deleted })
  } catch (err) {
    ctx.log.error('idempotency cleanup failed', err as Error)
    return errorResponse(err, ctx.log, { requestId: ctx.requestId })
  }
})
