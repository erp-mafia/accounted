import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { bookkeepingErrorResponse, AccountsNotInChartError, ACCOUNTS_NOT_IN_CHART } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { PendingOperation } from '@/types'

ensureInitialized()

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

      if (result.status === 'committed') {
        return NextResponse.json({ data: result.data })
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
