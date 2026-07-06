/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/uncategorize
 *
 * Reverse the categorization of a transaction:
 *   1. Storno the existing journal entry (BFL-compliant: JEs are never
 *      deleted, they're cancelled via a reversing entry).
 *   2. Reset is_business / category / journal_entry_id on the transaction.
 *
 * Idempotent. Dry-runnable. The body is empty: the transaction id in the
 * path is the only input.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const UncategorizeResponse = z.object({
  success: z.boolean(),
  reversed_journal_entry_id: z.string().uuid(),
})

registerEndpoint({
  operation: 'transactions.uncategorize',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/:id/uncategorize',
  summary: 'Reverse the categorization of a transaction (storno + reset).',
  description:
    'Storno the transaction\'s journal entry (BFL 5 kap 5 §: posted entries are never deleted, only cancelled via a reversing entry) and reset is_business / category / journal_entry_id on the transaction row. Idempotent: a second call on an already-uncategorized transaction returns 400 TX_UNCATEGORIZE_NOT_BOOKED. Dry-runnable.',
  useWhen:
    'You categorized a transaction by mistake and want to redo it from scratch. The storno keeps the audit trail intact.',
  doNotUseFor:
    'Changing the categorization of an already-booked transaction: categorize again instead (the second call sees journal_entry_id and only updates flags). Reversing a payment match: there is no v1 verb for that yet.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'The storno creates a new (cancelling) journal entry. The original entry stays in the ledger marked as cancelled: voucher gaps are documented automatically.',
    'A transaction without a journal_entry_id returns 400 TX_UNCATEGORIZE_NOT_BOOKED: there is nothing to reverse.',
  ],
  example: {
    response: {
      data: { success: true, reversed_journal_entry_id: 'je_…' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'medium',
  idempotent: true,
  reversible: false, // The reversal itself cannot be reversed via this endpoint.
  dryRunSupported: true,
  response: { success: dataEnvelope(UncategorizeResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.uncategorize',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Transaction id must be a UUID.' },
      })
    }
    const txId = idParse.data

    const { data: transaction, error: fetchErr } = await ctx.supabase
      .from('transactions')
      .select('id, journal_entry_id')
      .eq('id', txId)
      .eq('company_id', ctx.companyId!)
      .single()

    if (fetchErr || !transaction) {
      return v1ErrorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    if (!transaction.journal_entry_id) {
      return v1ErrorResponseFromCode('TX_UNCATEGORIZE_NOT_BOOKED', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    const { data: entry, error: entryErr } = await ctx.supabase
      .from('journal_entries')
      .select('id, status')
      .eq('id', transaction.journal_entry_id)
      .eq('company_id', ctx.companyId!)
      .single()
    if (entryErr || !entry) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'journal_entry' },
      })
    }
    if (entry.status !== 'posted') {
      return v1ErrorResponseFromCode('TX_UNCATEGORIZE_JE_NOT_POSTED', ctx.log, {
        requestId: ctx.requestId,
        details: { currentStatus: entry.status },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          would_storno_journal_entry_id: transaction.journal_entry_id,
          would_reset_transaction: { is_business: null, category: null, journal_entry_id: null },
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    try {
      await reverseEntry(ctx.supabase, ctx.companyId!, ctx.userId, transaction.journal_entry_id)
    } catch (err) {
      ctx.log.error('transactions.uncategorize: reversal failed', err as Error)
      if (isBookkeepingError(err)) {
        return v1ErrorResponseFromCode('TX_UNCATEGORIZE_JE_NOT_POSTED', ctx.log, {
          requestId: ctx.requestId,
          details: { message: getErrorMessage(err, { context: 'transaction' }) },
        })
      }
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }

    const { error: updateErr } = await ctx.supabase
      .from('transactions')
      .update({ is_business: null, category: null, journal_entry_id: null })
      .eq('id', txId)
      .eq('company_id', ctx.companyId!)
    if (updateErr) return v1ErrorResponse(updateErr, ctx.log, { requestId: ctx.requestId })

    return ok(
      {
        success: true,
        reversed_journal_entry_id: transaction.journal_entry_id as string,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
