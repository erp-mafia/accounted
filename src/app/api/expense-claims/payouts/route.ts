import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateExpensePayoutSchema } from '@/lib/api/schemas'
import { listPayoutBatches } from '@/lib/expenses/expense-claims-service'
import { recordExpensePayout } from '@/lib/expenses/expense-claim-actions'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

export const GET = withRouteContext('expense_claims.payouts.list', async (_request, { supabase, companyId }) => {
  const batches = await listPayoutBatches(supabase, companyId)
  return NextResponse.json({ data: batches })
})

/**
 * POST /api/expense-claims/payouts: record that one person was paid back for
 * their claims. The rules live in lib/expenses/expense-claim-actions.ts,
 * shared with the v1 operation expense-claims.record-payout and
 * gnubok_record_expense_payout.
 */
export const POST = withRouteContext(
  'expense_claims.payouts.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, CreateExpensePayoutSchema)
    if (!validation.success) return validation.response

    const outcome = await recordExpensePayout({ supabase, companyId, userId: user.id, log }, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: { ok: true, ...outcome.data } }, { status: 201 })
  },
  { requireWrite: true },
)
