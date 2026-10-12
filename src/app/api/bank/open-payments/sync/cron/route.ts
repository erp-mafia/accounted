import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { runOpenPaymentsCron } from '@/lib/bank-feed/cron'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceRoleClient } from '@/lib/supabase/service-client'

export const maxDuration = 300

/**
 * GET /api/bank/open-payments/sync/cron, hourly at :20 (vercel.json, the
 * Docker crontab). Removes abandoned consent attempts, expires consents that
 * have run out, and syncs the Open Payments connections that are due (every
 * 11 hours, four at a time, within a 230 s budget). A truthful no-op without
 * a connector key.
 */
export const GET = withCronContext('cron.open_payments_bank_sync', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, { requestId: ctx.requestId, details: { reason: 'Missing Supabase configuration' } })
  }
  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)
  const result = await runOpenPaymentsCron(supabase, ctx.log)
  ctx.log.info('open payments bank sync summary', result)
  return NextResponse.json(result)
})
