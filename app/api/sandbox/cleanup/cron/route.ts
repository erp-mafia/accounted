import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/sandbox/cleanup/cron: daily 04:00 UTC.
 * Removes expired sandbox users (>24h old).
 */
export const GET = withCronContext('cron.sandbox_cleanup', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const { data, error } = await supabase.rpc('cleanup_expired_sandbox_users', {
    p_max_age_hours: 24,
  })

  if (error) {
    ctx.log.error('sandbox cleanup rpc failed', error)
    return errorResponse(error, ctx.log, { requestId: ctx.requestId })
  }

  const cleaned = data ?? 0
  ctx.log.info('sandbox cleanup summary', { cleaned })

  return NextResponse.json({ success: true, cleaned })
})
