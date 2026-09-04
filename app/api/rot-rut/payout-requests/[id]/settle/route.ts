import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RotRutSettleSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { settleRotRutPayoutRequest } from '@/lib/invoices/rot-rut-settle'

/**
 * POST /api/rot-rut/payout-requests/[id]/settle
 *
 * Books Skatteverkets utbetalning for a begäran:
 *
 *   Debit  19xx bank account (default 1930)  [amount]
 *   Credit 1513 Skattereduktion rot/rut      [amount]
 *
 * The journal entry IS the accounting record here, so engine failure blocks
 * the operation (see .claude/skills/erp-api-route, payment entries block).
 * amount defaults to decided_total, falling back to requested_total. If the
 * amount equals requested_total the request completes as 'paid'; anything
 * lower records 'partially_paid' with decided_total = amount.
 *
 * Headless variant: no bank transaction is linked. The transactions inbox
 * settles the same request WITH the bank row through
 * POST /api/transactions/[id]/match-rot-rut-payout (shared service in
 * lib/invoices/rot-rut-settle.ts).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'rot_rut.requests.settle',
  async (request, ctx, { params }) => {
    const { user, supabase, companyId, log, requestId } = ctx
    const { id } = await params

    const validation = await validateBody(request, RotRutSettleSchema)
    if (!validation.success) return validation.response
    const input = validation.data

    const outcome = await settleRotRutPayoutRequest(supabase, user.id, companyId!, {
      requestId: id,
      paymentDate: input.payment_date,
      amount: input.amount,
      bankAccount: input.bank_account,
    })

    if (!outcome.ok) {
      if (outcome.kind === 'code') {
        return errorResponseFromCode(outcome.code, log, { requestId, details: outcome.details })
      }
      if (outcome.stage === 'fetch') {
        log.error('failed to fetch rot/rut payout request', outcome.error as Error)
      } else if (outcome.stage === 'book') {
        log.error('failed to book rot/rut payout entry', outcome.error as Error)
      }
      return errorResponse(outcome.error, log, { requestId })
    }

    log.info('rot/rut payout settled', {
      userId: user.id,
      payoutRequestId: id,
      journalEntryId: outcome.journalEntryId,
      amount: outcome.amount,
      fullyPaid: outcome.fullyPaid,
    })

    return NextResponse.json({
      data: { request: outcome.request, journal_entry_id: outcome.journalEntryId },
    })
  },
  { requireWrite: true },
)
