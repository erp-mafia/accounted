import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { addDays, todayIso } from '@/lib/arkiv/agreements/dates'
import { listAgreements, listObligations } from '@/lib/commitments/agreements'
import { listSecurities } from '@/lib/commitments/securities'
import { listGroupLinks } from '@/lib/commitments/group-links'
import type { OperationOutcome } from '@/lib/operations/types'

/** A read's data; reads never answer a dry run, and failures are answered before this. */
function dataOf<T>(outcome: OperationOutcome<T>): T {
  if (!outcome.ok || outcome.dryRun) throw new Error('commitments read without data')
  return outcome.data
}

/**
 * GET /api/commitments: everything the Avtal och åtaganden page shows, for
 * the active company: the agreements with their next payment and dates, the
 * payments due in the next 90 days and the ones missed lately, ställda
 * säkerheter and eventualförpliktelser with today's note texts, and the
 * group structure. 404 COMMITMENTS_UNAVAILABLE outside the Bolaget rollout.
 */
export const GET = withRouteContext('commitments.overview', async (_request, { supabase, companyId, user, log, requestId }) => {
  const ctx = { supabase, companyId, userId: user.id }
  const today = todayIso()
  const [agreements, obligations, securities, groupLinks] = await Promise.all([
    listAgreements(ctx, {}, today),
    listObligations(ctx, { from: addDays(today, -45), to: addDays(today, 90) }, today),
    listSecurities(ctx, { balance_date: today }),
    listGroupLinks(ctx),
  ])
  for (const outcome of [agreements, obligations, securities, groupLinks]) {
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  }
  const a = dataOf(agreements)
  const o = dataOf(obligations)
  const s = dataOf(securities)
  const g = dataOf(groupLinks)
  const upcoming = o.obligations.filter((row) => row.status === 'missed' || (row.status === 'expected' && row.due_on >= today))
  return NextResponse.json({
    data: {
      today,
      agreements: a.agreements,
      upcoming_payments: upcoming,
      securities: s.securities,
      note_texts: s.note_texts,
      group_links: g.group_links,
      group_structure_applies: g.applies,
    },
  })
})
