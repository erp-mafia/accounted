import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { unapproveSalaryRun } from '@/lib/salary/run-status-recall'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

/**
 * approved -> review (recall approval, unlock the run for recalculation).
 *
 * Approval is an internal control point: nothing legally binding has happened
 * until payment, booking, or AGI filing, so recalling it is allowed as long
 * as the AGI has not reached Skatteverket. Once the AGI is in flight
 * (pending_signature) or filed (submitted/accepted), the period must instead
 * be redone via a correction AGI with the same specifikationsnummer, so this
 * route refuses.
 *
 * The rules live in lib/salary/run-status-recall.ts, shared with the v1
 * operation salary-runs.unapprove and gnubok_unapprove_salary_run.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.unapprove',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const outcome = await unapproveSalaryRun({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data.run })
  },
  { requireWrite: true },
)
