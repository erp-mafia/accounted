import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { loadReminderOverview } from '@/lib/reminders/overview'
import { createServiceClient } from '@/lib/supabase/server'

/** One decision per overdue invoice (at most 100) to build the pick list. */
export const maxDuration = 60

/**
 * GET /api/reminders/overview: what the turn-on sheet shows for the active
 * company: whether reminders can be turned on and are, the ladder's days,
 * how many invoices are overdue, and the ones issued from Accounted before
 * reminders were on that a person may remind once, now.
 */
export const GET = withRouteContext('reminders.overview', async (_request, { companyId }) => {
  // Service role, filtered by the active company the wrapper resolved: the
  // facts span tables a member reads only in part (delivery evidence, cases).
  const overview = await loadReminderOverview(createServiceClient(), companyId, { now: new Date() })
  return NextResponse.json({ data: overview })
})
