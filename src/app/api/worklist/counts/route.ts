import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getWorklistCounts } from '@/lib/worklist'

/**
 * GET /api/worklist/counts: all pending-work counts for the active company.
 *
 * Powers the "Att göra" surfaces (home-page section, sidebar badges) and
 * client-side refetch after an inline action completes. Read-only; every
 * count is a cheap head-only query that soft-fails to 0: see lib/worklist.
 *
 * Response: { data: { counts: Record<WorklistCategory, number>, total,
 * overdueInvoices } }: overdueInvoices is the grouped overdue row's facts
 * (lib/worklist OverdueInvoicesDue) or null. The per-person rows
 * (documents_to_sign) are counted for the caller.
 */
export const GET = withRouteContext('worklist.counts', async (_request, ctx) => {
  const { supabase, companyId, user } = ctx
  const data = await getWorklistCounts(supabase, companyId, { userId: user.id })
  return NextResponse.json({ data })
})
