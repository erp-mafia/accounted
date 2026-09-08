import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { resolveCompanyCounterparts, resolverMode } from '@/lib/parties/resolver/run'

/**
 * POST /api/parties/resolver/run: name the new bank strings for the active
 * company now, instead of waiting for the nightly cron. The service client is
 * used because the shared directory has no member policies; the company is
 * the caller's active company and nothing else.
 */
export const POST = withRouteContext('parties.resolver_run', async (_request, { companyId, log, requestId }) => {
  if (resolverMode() === 'off') return NextResponse.json({ data: { skipped: true, planned: 0, written: 0 } })
  try {
    const summary = await resolveCompanyCounterparts(createServiceClient(), companyId, { maxModelLines: 200 })
    return NextResponse.json({
      data: { skipped: false, strings: summary.strings, planned: summary.planned, written: summary.written, modelLines: summary.modelLines, byBand: summary.byBand },
    })
  } catch (err) {
    log.warn('counterpart resolver run failed', { message: err instanceof Error ? err.message : String(err) })
    return errorResponseFromCode('INTERNAL_ERROR', log, { requestId })
  }
})
