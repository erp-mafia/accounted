import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listArchiveHistory } from '@/lib/arkiv/history'
import { createServiceClient } from '@/lib/supabase/server'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/history: what has happened to the company's documents,
 * newest first, from the logs that already exist. The audit log and the
 * processing history are read with the service role, filtered by the
 * active company: they are not member-readable through RLS.
 */
export const GET = withRouteContext('arkiv.history', async (_request, ctx) => {
  try {
    const events = await listArchiveHistory(createServiceClient(), ctx.companyId, 200)
    return NextResponse.json({ data: { events } })
  } catch (err) {
    ctx.log.error('archive history failed', { reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 })
  }
})
