import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { loadReminderOverview, loadReminderSummary } from '@/lib/reminders/overview'
import { createServiceClient } from '@/lib/supabase/server'

/** One decision per overdue invoice (at most 100) to build the pick list. */
export const maxDuration = 60

const QuerySchema = z.object({
  /** summary: the switches and the offer's count (the invoice list); default: the whole sheet. */
  view: z.enum(['summary', 'full']).optional(),
})

/**
 * GET /api/reminders/overview: what the turn-on sheet shows for the active
 * company: whether reminders can be turned on and are, the ladder's days,
 * how many invoices are overdue, and the ones issued from Accounted before
 * reminders were on that a person may remind once, now. With view=summary,
 * only the switches and the count the invoice list's offer needs: no pick
 * list, so a visit to the list costs a handful of queries.
 */
export const GET = withRouteContext('reminders.overview', async (request, { companyId, log }) => {
  const query = validateQuery(request, QuerySchema, { log, operation: 'reminders.overview' })
  if (!query.success) return query.response
  // Service role, filtered by the active company the wrapper resolved: the
  // facts span tables a member reads only in part (delivery evidence, cases).
  const db = createServiceClient()
  const now = new Date()
  const data =
    query.data.view === 'summary'
      ? await loadReminderSummary(db, companyId, { now })
      : await loadReminderOverview(db, companyId, { now })
  return NextResponse.json({ data })
})
