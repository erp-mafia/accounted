import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { recordAppApproval } from '@/lib/pending-operations/record-app-approval'
import { bookkeepingErrorResponse, AccountsNotInChartError, ACCOUNTS_NOT_IN_CHART } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { PendingOperation } from '@/types'

// An approved match_batch_allocate of MAX_BANK_ROW_SPLIT invoices commits here
// (lib/reconciliation/limits.ts): same budget as the match-batch route.
export const maxDuration = 300

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pending_operation.commit',
  async (_request, { supabase, user, companyId, log }, { params }) => {
    const { id } = await params

    const { data: op, error: fetchError } = await supabase
      .from('pending_operations')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !op) {
      return NextResponse.json({ error: 'Pending operation not found' }, { status: 404 })
    }

    try {
      const result = await commitPendingOperation(
        supabase,
        user.id,
        companyId,
        op as PendingOperation,
        {
          userEmail: user.email,
          commitMethod: 'user_accept',
          actor: { type: 'user', ...(user.email ? { label: user.email } : {}) },
        }
      )
      await recordAppApproval({
        companyId,
        userId: user.id,
        operation: op as PendingOperation,
        commitMethod: 'user_accept',
        outcome: result.status,
      })

      if (result.status === 'committed') {
        return NextResponse.json({ data: result.data })
      }
      // Lost the pending -> committing claim: the operation was already
      // approved (a second click, another tab) or rejected, or another
      // approval is running it. Nothing ran here. The v1 approve door's
      // answer, instead of the generic 409 "En konflikt uppstod" that read
      // as a failed approval.
      if (result.http_status === 409 && result.operation_status === undefined) {
        return errorResponseFromCode('PENDING_OPERATION_NOT_PENDING', log)
      }
      // Recoverable accounts-not-in-chart: return the structured envelope (code +
      // account_numbers) so the client can offer activation and retry the still-
      // pending op, instead of leaking the raw error string into the chat.
      if (result.code === ACCOUNTS_NOT_IN_CHART && result.account_numbers?.length) {
        const structured = bookkeepingErrorResponse(
          new AccountsNotInChartError(result.account_numbers)
        )
        if (structured) return structured
      }
      // The executor's error strings mix Swedish user messages with raw
      // Supabase/Zod English; the pending page toasts this field verbatim, so
      // map it here. Swedish passes through untouched, English falls to the
      // status-appropriate Swedish fallback (issue #337). Raw stays in logs.
      const status = result.http_status ?? 500
      log.warn('pending operation commit failed', {
        operationId: id,
        rawError: result.error,
        status,
      })
      return NextResponse.json(
        { error: getErrorMessage(result.error ?? null, { statusCode: status }) },
        { status }
      )
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      throw err
    }
  },
  { requireWrite: true },
)
