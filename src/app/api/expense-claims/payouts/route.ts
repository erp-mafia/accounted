import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateExpensePayoutSchema } from '@/lib/api/schemas'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  createPayoutBatch,
  listPayoutBatches,
} from '@/lib/expenses/expense-claims-service'
import { PAYOUT_ERROR_MESSAGES } from '@/lib/expenses/payout-error-messages'

ensureInitialized()


export const GET = withRouteContext('expense_claims.payouts.list', async (_request, { supabase, companyId }) => {
  const batches = await listPayoutBatches(supabase, companyId)
  return NextResponse.json({ data: batches })
})

export const POST = withRouteContext(
  'expense_claims.payouts.create',
  async (request, { supabase, companyId, user, log }) => {
    const validation = await validateBody(request, CreateExpensePayoutSchema)
    if (!validation.success) return validation.response

    try {
      const result = await createPayoutBatch(supabase, companyId, user.id, validation.data)
      if (!result.ok) {
        const mapped = PAYOUT_ERROR_MESSAGES[result.code] ?? {
          message: 'Utbetalningen kunde inte skapas.',
          status: 500,
        }
        if (mapped.status >= 500) {
          log.error('expense payout failed', new Error(result.detail ?? result.code))
        }
        return NextResponse.json({ error: mapped.message, code: result.code }, { status: mapped.status })
      }
      return NextResponse.json({ data: result }, { status: 201 })
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      log.error('failed to create expense payout', err as Error)
      return NextResponse.json(
        { error: getErrorMessage(err, { context: 'journal_entry' }) },
        { status: 500 },
      )
    }
  },
  { requireWrite: true },
)
