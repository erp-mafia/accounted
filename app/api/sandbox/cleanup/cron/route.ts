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

  // Migration 20260807130000 changed the RPC's return from a bare integer to
  // a {cleaned, failed, orphans_removed} summary; accept both shapes so
  // deploy/migration ordering cannot break the cron.
  const summary =
    typeof data === 'number'
      ? { cleaned: data, failed: 0, orphans_removed: 0 }
      : {
          cleaned: Number(data?.cleaned ?? 0),
          failed: Number(data?.failed ?? 0),
          orphans_removed: Number(data?.orphans_removed ?? 0),
        }

  // Per-user failures used to be swallowed as Postgres WARNINGs, which is how
  // the cleanup sat broken for months; surface them at error level instead.
  if (summary.failed > 0) {
    ctx.log.error('sandbox cleanup completed with failures', summary)
  } else {
    ctx.log.info('sandbox cleanup summary', summary)
  }

  return NextResponse.json({ success: true, ...summary })
})
