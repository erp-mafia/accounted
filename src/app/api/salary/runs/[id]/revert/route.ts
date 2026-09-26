import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { revertSalaryRunToDraft } from '@/lib/salary/run-status-recall'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

/**
 * review -> draft (unlock for editing). The rule lives in
 * lib/salary/run-status-recall.ts, shared with the v1 operation
 * salary-runs.revert and gnubok_revert_salary_run.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.revert',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const outcome = await revertSalaryRunToDraft({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data.run })
  },
  { requireWrite: true },
)
