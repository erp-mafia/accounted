import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { recordAppApproval } from '@/lib/pending-operations/record-app-approval'
import { bookkeepingErrorResponse, AccountsNotInChartError, ACCOUNTS_NOT_IN_CHART } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { PendingOperation } from '@/types'
import { z } from 'zod'

/**
 * The one thing an approval may add: the possible duplicate the person looked
 * at and books over ("Bokför ändå" in the duplicate dialog). No body is the
 * plain approval.
 */
const CommitBodySchema = z.object({
  expected_duplicate_journal_entry_id: z.string().uuid().optional(),
})

/** The duplicate refusals a single approval answers in the app instead of losing the proposal. */
const DUPLICATE_REVIEW_CODES = new Set(['TRANSACTION_BOOK_POSSIBLE_DUPLICATE', 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH'])

// An approved match_batch_allocate of MAX_BANK_ROW_SPLIT invoices commits here
// (lib/reconciliation/limits.ts): same budget as the match-batch route.
export const maxDuration = 300

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pending_operation.commit',
  async (request, { supabase, user, companyId, log }, { params }) => {
    const { id } = await params

    // The plain approval sends no body at all.
    const rawBody = await request.text()
    let parsedBody: unknown = {}
    if (rawBody.trim() !== '') {
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {
        // Not JSON: answered as a validation error, which logs the refusal.
        return errorResponseFromCode('VALIDATION_ERROR', log)
      }
    }
    const body = CommitBodySchema.safeParse(parsedBody)
    if (!body.success) return errorResponseFromCode('VALIDATION_ERROR', log)
    const expectedDuplicate = body.data.expected_duplicate_journal_entry_id

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
          // A possible duplicate is the person's call, made here: the
          // proposal waits for it instead of being consumed.
          duplicateReview: expectedDuplicate ? { expectedJournalEntryId: expectedDuplicate } : {},
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
      // A possible duplicate on a proposal that is still pending: the
      // structured refusal with the candidate, which the page answers in the
      // duplicate dialog (match, book anyway, ignore, or leave it).
      if (result.code && DUPLICATE_REVIEW_CODES.has(result.code) && result.operation_status === 'pending') {
        const candidate = (result.data as { candidate?: unknown } | undefined)?.candidate
        return errorResponseFromCode(result.code, log, candidate ? { details: { candidate } } : {})
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
