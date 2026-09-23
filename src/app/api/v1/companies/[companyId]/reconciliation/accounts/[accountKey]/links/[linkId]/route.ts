/**
 * DELETE /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/links/{linkId}
 *
 * Remove one link. linkId is the outside row's id (transaction id on a bank
 * account, skattekonto_transaction id on the skattekonto): one row holds at
 * most one link, so the row id is the link id. The verifikat is untouched.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { unmatchLink } from '@/lib/reconciliation/actions'

const UnlinkResponse = z.object({
  external_id: z.string(),
  previous_journal_entry_id: z.string().nullable(),
})

registerEndpoint({
  operation: 'reconciliation.accounts.links.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/reconciliation/accounts/:accountKey/links/:linkId',
  summary: 'Remove a link between an outside row and a verifikat.',
  description:
    'Clears the link on one outside row (bank transaction or skattekonto row). The verifikat is never edited or deleted (BFL); only the row\'s pointer is cleared, so the pair returns to the open buckets and proposals are recomputed on the next sync. Allowed in locked periods. ?dry_run=true reports what would be unlinked.',
  useWhen:
    'A link was wrong (a bulk proposal apply that paired the wrong verifikat, a manual mistake).',
  doNotUseFor:
    'Undoing a booking: a residual or categorization booking is reversed through the journal-entry reverse endpoint, not by unlinking.',
  pitfalls: [
    'linkId is the outside row id, not a separate link entity.',
    'Unlinking a row whose verifikat was stornoed is the expected fix for a link_problem = entry_reversed item; the row then shows under unmatched_external again.',
  ],
  example: {
    response: {
      data: { external_id: '33333333-3333-4333-8333-333333333333', previous_journal_entry_id: '44444444-4444-4444-8444-444444444444' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reconciliation:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  response: { success: dataEnvelope(UnlinkResponse) },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; accountKey: string; linkId: string }> }>(
  'reconciliation.accounts.links.delete',
  async (_request, ctx, params) => {
    const { accountKey, linkId } = await params.params
    if (!AccountKeySchema.safeParse(accountKey).success || !z.string().uuid().safeParse(linkId).success) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'linkId', message: 'Okänd koppling.' },
      })
    }
    try {
      if (ctx.dryRun) {
        return dryRunPreview({ external_id: linkId, would_unlink: true }, { requestId: ctx.requestId, log: ctx.log })
      }
      const result = await unmatchLink(ctx.supabase, ctx.companyId!, ctx.userId, accountKey, linkId)
      if (!result) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'accountKey', message: 'Okänt konto för det här företaget.' },
        })
      }
      return ok(result, { requestId: ctx.requestId })
    } catch (err) {
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
