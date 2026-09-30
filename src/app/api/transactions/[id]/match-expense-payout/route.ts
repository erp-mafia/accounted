import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MatchExpensePayoutSchema } from '@/lib/api/schemas'
import { matchExpensePayout } from '@/lib/expenses/expense-claim-actions'
import { sessionFailureResponse } from '@/lib/operations/session'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-expense-payout
 *
 * Book an outgoing bank row as the repayment of one person's registered
 * utlägg (liability -> the row's own 19xx account), linked to the voucher
 * inside the same RPC transaction so the transfer can never be booked twice.
 * The rules live in lib/expenses/expense-claim-actions.ts, shared with the v1
 * operation transactions.match-expense-payout and gnubok_match_expense_payout.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.match_expense_payout',
  async (request, { user, supabase, companyId, log, requestId }, { params }) => {
    const { id: transactionId } = await params

    const validation = await validateBody(request, MatchExpensePayoutSchema, {
      log,
      operation: 'transaction.match_expense_payout',
    })
    if (!validation.success) return validation.response

    const outcome = await matchExpensePayout(
      { supabase, companyId, userId: user.id, log },
      { transaction_id: transactionId, claim_ids: validation.data.claim_ids },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    return NextResponse.json({
      success: true,
      journal_entry_id: outcome.data.journal_entry_id,
      batch_id: outcome.data.batch_id,
      voucher_number: outcome.data.voucher_number,
      total_sek: outcome.data.total_sek,
      claim_count: outcome.data.claim_count,
      category: 'expense_other',
    })
  },
  { requireWrite: true },
)
