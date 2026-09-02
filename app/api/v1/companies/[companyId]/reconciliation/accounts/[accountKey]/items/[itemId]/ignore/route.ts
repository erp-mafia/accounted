/**
 * POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/items/{itemId}/ignore
 *
 * Ignore or restore one outside row. Body { ignored: boolean } (default true).
 * Ignored rows leave the unmatched totals and surface on the bridge's
 * exclusion line; nothing is deleted and the flag is reversible.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { setItemIgnored } from '@/lib/reconciliation/actions'

const IgnoreRequest = z.object({ ignored: z.boolean().optional() })
const IgnoreResponse = z.object({ external_id: z.string(), is_ignored: z.boolean() })

registerEndpoint({
  operation: 'reconciliation.accounts.items.ignore',
  method: 'POST',
  path: '/api/v1/companies/:companyId/reconciliation/accounts/:accountKey/items/:itemId/ignore',
  summary: 'Ignore or restore one outside row.',
  description:
    'Sets the ignore flag on one outside row (bank transaction or skattekonto row). Body { ignored: true | false }, default true. An ignored row never has a link; ignoring a linked row is refused (unlink first). Ignored rows are excluded from the unmatched totals and listed on the bridge\'s exclusion line so they never disappear silently.',
  useWhen:
    'A row will never have a counterpart (a duplicate from a reconnect, an event that predates the books) and should stop counting as work.',
  doNotUseFor:
    'Rows that should be booked or linked; ignoring is triage, not settlement.',
  pitfalls: [
    'Ignoring is reversible (ignored: false) and audited through the row itself; nothing is deleted.',
    'For the skattekonto, an ignored row still counts toward the derived opening balance (it is a real Skatteverket movement); the bridge shows it on its own line.',
  ],
  example: {
    request: { ignored: true },
    response: {
      data: { external_id: '33333333-3333-4333-8333-333333333333', is_ignored: true },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reconciliation:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: IgnoreRequest },
  response: { success: dataEnvelope(IgnoreResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; accountKey: string; itemId: string }> }>(
  'reconciliation.accounts.items.ignore',
  async (request, ctx, params) => {
    const { accountKey, itemId } = await params.params
    if (!AccountKeySchema.safeParse(accountKey).success || !z.string().uuid().safeParse(itemId).success) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'itemId', message: 'Okänd rad.' },
      })
    }
    let body: unknown = {}
    try {
      const text = await request.text()
      body = text ? JSON.parse(text) : {}
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = IgnoreRequest.safeParse(body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const ignored = parsed.data.ignored ?? true
    try {
      if (ctx.dryRun) {
        return dryRunPreview({ external_id: itemId, would_set_ignored: ignored }, { requestId: ctx.requestId, log: ctx.log })
      }
      const result = await setItemIgnored(ctx.supabase, ctx.companyId!, accountKey, itemId, ignored)
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
