/**
 * POST   /api/v1/companies/{companyId}/transactions/{id}/ignore
 * DELETE /api/v1/companies/{companyId}/transactions/{id}/ignore
 *
 * Mark a bank transaction as ignored (POST) or restore it (DELETE). Ignoring
 * writes no verifikat: it is the path for rows that are not affärshändelser
 * (PSD2 ghost rows, duplicates from a reconnect, transfers that never
 * executed), and it is the only way to clear such rows out of a locked or
 * closed period, where a private marking (a real eget uttag/insättning
 * booking) is refused with TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED (issue #1661).
 *
 * Both verbs are idempotent and dry-runnable; the transaction id in the path
 * is the only input. The booked check uses lib/transactions/is-booked.ts so a
 * bulk-booked or multi-allocated row (journal_entry_id NULL, anchored through
 * a junction table) is refused like a directly booked one.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { setTransactionIgnored } from '@/lib/transactions/ignore'

const IgnoreResponse = z.object({
  success: z.boolean(),
  transaction_id: z.string().uuid(),
  is_ignored: z.literal(true),
  /** true when the row was already ignored: nothing changed. */
  already_ignored: z.boolean(),
})

const UnignoreResponse = z.object({
  success: z.boolean(),
  transaction_id: z.string().uuid(),
  is_ignored: z.literal(false),
  /** false when the row was not ignored to begin with: nothing changed. */
  was_ignored: z.boolean(),
})

registerEndpoint({
  operation: 'transactions.ignore',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/:id/ignore',
  summary: 'Ignore a bank transaction (no verifikat, allowed in locked periods).',
  description:
    'Marks an unbooked bank transaction as ignored so it leaves the "to book" funnels and the reconciliation unmatched totals without creating a verifikat. Nothing is deleted and the flag is reversible with DELETE on the same path. Because no booking is written, a locked or closed fiscal period does not block it: this is the path for clearing rows that are not business events out of a closed period. A booked transaction (directly, via a payment allocation, or via a voucher link) is refused with 409 TX_IGNORE_ALREADY_BOOKED. Idempotent: ignoring an already-ignored row returns already_ignored: true. Dry-runnable.',
  useWhen:
    'The row is not an affärshändelse: a PSD2 ghost row, a duplicate from a bank reconnect, a transfer that never executed, rounding noise. Also the answer to TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED from /categorize when the row should not be booked at all.',
  doNotUseFor:
    'Real purchases, payments or owner withdrawals: those must be booked (categorize, match-invoice, or is_business: false in an open period). Ignoring is triage, not bookkeeping.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'A booked row cannot be ignored: reverse it first (POST /transactions/{id}/uncategorize) or unlink the payment/voucher.',
    'Ignored rows still exist and are listed on the reconciliation bridge\'s ignored line; they never disappear silently.',
  ],
  example: {
    response: {
      data: { success: true, transaction_id: 'tx_…', is_ignored: true, already_ignored: false },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  response: { success: dataEnvelope(IgnoreResponse) },
})

registerEndpoint({
  operation: 'transactions.unignore',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/transactions/:id/ignore',
  summary: 'Restore an ignored bank transaction to the "to book" list.',
  description:
    'Clears the ignore flag set by POST on the same path. The row comes back into the unbooked list and the reconciliation unmatched totals; no verifikat was ever written, so there is nothing to reverse. Idempotent: restoring a row that is not ignored returns was_ignored: false. Dry-runnable.',
  useWhen: 'A row was ignored by mistake and should be booked after all.',
  doNotUseFor:
    'Undoing a booking: that is a storno via POST /transactions/{id}/uncategorize.',
  pitfalls: ['Idempotency-Key is mandatory.'],
  example: {
    response: {
      data: { success: true, transaction_id: 'tx_…', is_ignored: false, was_ignored: true },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  response: { success: dataEnvelope(UnignoreResponse) },
})

function parseTransactionId(id: string): string | null {
  const parsed = z.string().uuid().safeParse(id)
  return parsed.success ? parsed.data : null
}

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.ignore',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const txId = parseTransactionId(id)
    if (!txId) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Transaction id must be a UUID.' },
      })
    }

    try {
      const outcome = await setTransactionIgnored(ctx.supabase, ctx.companyId!, txId, true, {
        dryRun: ctx.dryRun,
      })
      if (!outcome.ok) {
        return v1ErrorResponseFromCode(outcome.code, ctx.log, {
          requestId: ctx.requestId,
          details: { transaction_id: txId },
        })
      }
      if (ctx.dryRun) {
        return dryRunPreview(
          { transaction_id: txId, would_set_ignored: true, already_ignored: !outcome.changed },
          { requestId: ctx.requestId, log: ctx.log },
        )
      }
      return ok(
        {
          success: true,
          transaction_id: txId,
          is_ignored: true as const,
          already_ignored: !outcome.changed,
        },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      ctx.log.error('transactions.ignore failed', err as Error)
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.unignore',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const txId = parseTransactionId(id)
    if (!txId) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Transaction id must be a UUID.' },
      })
    }

    try {
      const outcome = await setTransactionIgnored(ctx.supabase, ctx.companyId!, txId, false, {
        dryRun: ctx.dryRun,
      })
      if (!outcome.ok) {
        return v1ErrorResponseFromCode(outcome.code, ctx.log, {
          requestId: ctx.requestId,
          details: { transaction_id: txId },
        })
      }
      if (ctx.dryRun) {
        return dryRunPreview(
          { transaction_id: txId, would_set_ignored: false, was_ignored: outcome.changed },
          { requestId: ctx.requestId, log: ctx.log },
        )
      }
      return ok(
        {
          success: true,
          transaction_id: txId,
          is_ignored: false as const,
          was_ignored: outcome.changed,
        },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      ctx.log.error('transactions.unignore failed', err as Error)
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
