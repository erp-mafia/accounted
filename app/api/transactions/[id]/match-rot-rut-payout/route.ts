import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MatchRotRutPayoutSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { matchTransactionToRotRutPayout } from '@/lib/invoices/rot-rut-match-transaction'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-rot-rut-payout
 *
 * Match an income bank row to the ROT/RUT begäran whose payout it is:
 *
 *   Debit  19xx (the transaction's cash account)  [tx.amount]
 *   Credit 1513 Skattereduktion rot/rut           [tx.amount]
 *
 * Same settle as POST /api/rot-rut/payout-requests/[id]/settle, but amount,
 * date and bank account come from the bank row and the row is linked to the
 * voucher in the same call, so the payout can never be booked twice (once by
 * settle, once by categorising the bank row).
 *
 * Skatteverket bundles the beslut it pays that day into one transfer, so the
 * body may name several begäran (`request_ids`, #2239): then ONE voucher
 * carries one 1513 credit per begäran and the row is linked to it, provided
 * the expected payouts sum to the row exactly.
 *
 * The pre-flight and the settle live in lib/invoices/rot-rut-match-transaction
 * (shared with the MCP settle_rot_rut_payout executor); this route only maps
 * the outcome to HTTP.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.match_rot_rut_payout',
  async (request, ctx, { params }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchRotRutPayoutSchema, {
      log,
      operation: 'transaction.match_rot_rut_payout',
    })
    if (!validation.success) return validation.response
    const payoutRequestIds = [
      ...new Set(validation.data.request_ids ?? [validation.data.request_id!]),
    ]

    const txLog = log.child({ transactionId, payoutRequestIds })

    const outcome = await matchTransactionToRotRutPayout(
      supabase,
      user.id,
      companyId!,
      { transactionId, requestIds: payoutRequestIds },
      txLog,
    )

    if (!outcome.ok) {
      if (outcome.kind === 'code') {
        return errorResponseFromCode(outcome.code, txLog, { requestId, details: outcome.details })
      }
      if (outcome.stage === 'book') {
        txLog.error('failed to book rot/rut payout entry', outcome.error as Error)
      }
      return errorResponse(outcome.error, txLog, { requestId })
    }

    txLog.info('rot/rut payout matched from bank transaction', {
      userId: user.id,
      journalEntryId: outcome.journalEntryId,
      amount: outcome.amount,
      fullyPaid: outcome.fullyPaid,
    })

    return NextResponse.json({
      success: true,
      journal_entry_id: outcome.journalEntryId,
      ...(outcome.request ? { request: outcome.request } : { requests: outcome.requests }),
      category: 'income_other',
    })
  },
  { requireWrite: true },
)
