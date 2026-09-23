import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { getCompanyGraph } from '@/lib/arkiv/graph/snapshot'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/brain: the company graph (Arkiv phase 9b's read model) for
 * Företagshjärnan, the Arkiv home. The same snapshot the agent reads through
 * Accounted://arkiv/graph; rebuilt on the way out when missing or stale. The
 * service client does the rebuild so the snapshot is saved for the next
 * reader; membership is what withRouteContext already established.
 */
export const GET = withRouteContext('arkiv.brain', async (_request, ctx) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const graph = await getCompanyGraph(createServiceClient(), ctx.companyId)
    return NextResponse.json({ data: graph })
  } catch (err) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 })
  }
})
