import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { deleteExpenseClaim } from '@/lib/expenses/expense-claims-service'

ensureInitialized()

const DELETE_ERROR_MESSAGES: Record<string, { message: string; status: number }> = {
  NOT_FOUND: { message: 'Utlägget hittades inte', status: 404 },
  ALREADY_PAID: {
    message: 'Utlägget är redan utbetalt och kan inte tas bort.',
    status: 409,
  },
  DELETE_FAILED: { message: 'Utlägget kunde inte tas bort.', status: 500 },
}

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'expense_claims.delete',
  async (_request, { supabase, companyId, user, log }, { params }) => {
    const { id } = await params
    try {
      const result = await deleteExpenseClaim(supabase, companyId, user.id, id)
      if (!result.ok) {
        const mapped = DELETE_ERROR_MESSAGES[result.code] ?? {
          message: 'Utlägget kunde inte tas bort.',
          status: 500,
        }
        if (mapped.status >= 500) {
          log.error('expense claim delete failed', new Error(result.detail ?? result.code))
        }
        return NextResponse.json({ error: mapped.message, code: result.code }, { status: mapped.status })
      }
      return NextResponse.json({
        data: { id, deleted: true, reversal_entry_id: result.reversal_entry_id },
      })
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      log.error('failed to delete expense claim', err as Error)
      return NextResponse.json(
        { error: getErrorMessage(err, { context: 'journal_entry' }) },
        { status: 400 },
      )
    }
  },
  { requireWrite: true },
)
