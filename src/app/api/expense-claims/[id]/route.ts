import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { removeExpenseClaim } from '@/lib/expenses/expense-claim-actions'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

/**
 * DELETE /api/expense-claims/[id]: remove an unpaid utlägg. Its verifikat is
 * reversed with a storno entry, never deleted (BFL 5 kap 5 §). The rules live
 * in lib/expenses/expense-claim-actions.ts, shared with the v1 operation
 * expense-claims.delete and gnubok_delete_expense_claim.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'expense_claims.delete',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const outcome = await removeExpenseClaim({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({
      data: { id, deleted: true, reversal_entry_id: outcome.data.reversal_entry_id },
    })
  },
  { requireWrite: true },
)
