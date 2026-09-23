import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { arkivUsageSummary } from '@/lib/arkiv/usage'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/usage: what the pipeline did for the company the last
 * rolling year (Arkiv phase 9e), for the billing page. Shown, not enforced.
 * 404 outside the rollout.
 */
export const GET = withRouteContext('arkiv.usage', async (_request, ctx) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    return NextResponse.json({ data: await arkivUsageSummary(ctx.supabase, ctx.companyId) })
  } catch (err) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 })
  }
})
