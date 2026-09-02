/**
 * POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/signoff/{signoffId}/reopen
 *
 * Undo a sign-off. The row stays as history with a reopen stamp (who, when,
 * why); the account then shows its previous active sign-off, if any.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { AccountKeySchema, ReconciliationSignoffSchema } from '@/lib/reconciliation/schemas'
import { ReconciliationSignoffError, reopenSignoff } from '@/lib/reconciliation/signoff'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const ReopenRequest = z.object({ reason: z.string().max(2000).nullable().optional() })
const ReopenResponse = z.object({ signoff: ReconciliationSignoffSchema })

registerEndpoint({
  operation: 'reconciliation.accounts.signoff.reopen',
  method: 'POST',
  path: '/api/v1/companies/:companyId/reconciliation/accounts/:accountKey/signoff/:signoffId/reopen',
  summary: 'Reopen (undo) a reconciliation sign-off.',
  description:
    'Body: { reason? }. Stamps the sign-off reopened_at/by/reason; nothing is deleted and the ledger is untouched. After this the account can be signed off again for the same or an earlier date. A sign-off that is already reopened is ALREADY_REOPENED (CONFLICT).',
  useWhen: 'A signed-off period turns out to need more work (a late bank row, a corrected verifikat) and the attestation must be withdrawn before it is redone.',
  doNotUseFor: 'Removing a link or un-booking anything: those are separate operations; reopening only withdraws the attestation.',
  pitfalls: [
    'Reopening is recorded, not erased: the history endpoint (?include_reopened=true) keeps showing the row with its reopen stamp.',
    'Idempotency-Key is required; repeating the same key replays the first response.',
  ],
  example: {
    request: { reason: 'Sen bankrad 31 juli kom in 3 augusti.' },
    response: {
      data: {
        signoff: {
          id: '77777777-7777-4777-8777-777777777777',
          account_key: 'skattekonto',
          through_date: '2026-07-31',
          external_balance: 12450.0,
          ledger_balance: 12450.0,
          unexplained_difference: 0,
          note: null,
          signed_by: '88888888-8888-4888-8888-888888888888',
          signed_at: '2026-08-03T09:12:00Z',
          reopened_at: '2026-08-04T07:30:00Z',
          reopened_by: '88888888-8888-4888-8888-888888888888',
          reopen_reason: 'Sen bankrad 31 juli kom in 3 augusti.',
        },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reconciliation:signoff',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: ReopenRequest },
  response: { success: dataEnvelope(ReopenResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; accountKey: string; signoffId: string }> }>(
  'reconciliation.accounts.signoff.reopen',
  async (request, ctx, params) => {
    const { accountKey, signoffId } = await params.params
    if (!AccountKeySchema.safeParse(accountKey).success || !z.string().uuid().safeParse(signoffId).success) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'signoffId', message: 'Okänd signering.' },
      })
    }
    let rawBody: unknown = {}
    try {
      const text = await request.text()
      rawBody = text ? JSON.parse(text) : {}
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = ReopenRequest.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    try {
      if (ctx.dryRun) {
        return dryRunPreview(
          { signoff_id: signoffId, would_reopen: true },
          { requestId: ctx.requestId, log: ctx.log },
        )
      }
      const signoff = await reopenSignoff(ctx.supabase, ctx.companyId!, ctx.userId, accountKey, signoffId, {
        reason: parsed.data.reason ?? null,
      })
      if (!signoff) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'accountKey', message: 'Okänt konto för det här företaget.' },
        })
      }
      return ok({ signoff }, { requestId: ctx.requestId })
    } catch (err) {
      if (err instanceof ReconciliationSignoffError) {
        const v1Code =
          err.code === 'SIGNOFF_NOT_FOUND'
            ? 'NOT_FOUND'
            : err.code === 'ALREADY_REOPENED' || err.code === 'SIGNOFF_RACE'
              ? 'CONFLICT'
              : 'VALIDATION_ERROR'
        return v1ErrorResponseFromCode(v1Code, ctx.log, {
          requestId: ctx.requestId,
          details: { code: err.code, message: getErrorMessage(err) },
        })
      }
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
