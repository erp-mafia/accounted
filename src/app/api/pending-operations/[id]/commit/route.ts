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
  async (request, { supabase, user, companyId, log }, { params }) => {
    const { id } = await params
    // Optional body { as_draft: true }: approve a create_voucher op into an
    // editable, unnumbered draft instead of posting it. An empty body is the
    // plain approval. A body we cannot read is a caller bug and gets a 400:
    // falling back to the plain approval would post an immutable verifikat
    // when the caller asked for a draft.
    let asDraft = false
    const rawText = await request.text()
    if (rawText.trim()) {
      let body: unknown
      try {
        body = JSON.parse(rawText)
      } catch {
        return NextResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Ogiltig JSON i förfrågan.',
              message_en: 'Body is not valid JSON.',
            },
          },
          { status: 400 },
        )
      }
      const flag =
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? (body as { as_draft?: unknown }).as_draft
          : null
      if (flag !== undefined && typeof flag !== 'boolean') {
        return NextResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Ogiltigt fält i förfrågan.',
              message_en: 'Body must be an object; as_draft must be a boolean.',
            },
          },
          { status: 400 },
        )
      }
      asDraft = flag === true
    }

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
          asDraft,
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
