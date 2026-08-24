/**
 * POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/links
 *
 * Link outside rows to existing verifikat on one account. Pairs, or the
 * persisted proposals. Writes nothing to the ledger: a link only points a
 * row at a verifikat, so it is allowed in locked periods and reversible by
 * DELETE .../links/{linkId}. Dry-runnable; Idempotency-Key required.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { matchPairs } from '@/lib/reconciliation/actions'

const PairSchema = z.object({
  external_ids: z.array(z.string().uuid()).min(1).max(50),
  journal_entry_ids: z.array(z.string().uuid()).min(1).max(50),
})

const LinksRequest = z
  .object({
    pairs: z.array(PairSchema).max(200).optional(),
    use_proposals: z.boolean().optional(),
    confidence_threshold: z.number().min(0).max(1).optional(),
  })
  .refine((b) => (b.pairs && b.pairs.length > 0) || b.use_proposals === true, {
    message: 'Ange pairs eller use_proposals: true.',
  })

const LinksResponse = z.object({
  dry_run: z.boolean(),
  considered: z.number().int(),
  applied: z.array(
    z.object({
      external_id: z.string(),
      journal_entry_id: z.string(),
      via: z.enum(['line', 'entry_total']).optional(),
    }),
  ),
  skipped: z.array(
    z.object({
      pair: PairSchema,
      code: z.string(),
      message: z.string(),
    }),
  ),
})

registerEndpoint({
  operation: 'reconciliation.accounts.links.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/reconciliation/accounts/:accountKey/links',
  summary: 'Link outside rows to existing verifikat (pairs or proposals).',
  description:
    'Body: { pairs: [{ external_ids: [id], journal_entry_ids: [id] }] } and/or { use_proposals: true, confidence_threshold? }. Each pair is validated as the single-link paths validate (row open and not ignored, entry posted and not reversed, the entry\'s account lines settle the amount, entry not already linked) and applied independently: the response lists applied[] and skipped[{pair, code, message}] so partial success is explicit. Codes: UNSUPPORTED_PAIR_SHAPE, ALREADY_LINKED, ENTRY_NOT_FOUND, PAIR_NOT_CLOSED, ROW_IGNORED, NOT_FOUND, LINK_RACE. ?dry_run=true returns the pairs that would be attempted without writing.',
  useWhen:
    'An agent or integration has decided which rows explain each other, or wants to apply the proposals the sync already computed.',
  doNotUseFor:
    'Booking new verifikat for rows that have no counterpart (use the transactions or skattekonto booking endpoints); reconciling across accounts.',
  pitfalls: [
    'This version links one outside row to one verifikat per pair; other shapes come back as UNSUPPORTED_PAIR_SHAPE, never silently reduced.',
    'A pair must close to the row\'s amount on the expected side (a single matching line, or the entry\'s lines on the account netting to it); a fee or rounding difference is PAIR_NOT_CLOSED here and needs a residual booking first.',
    'Links never touch the ledger, so they succeed in locked periods; unlink with DELETE .../links/{linkId} (linkId = the outside row id).',
    'Idempotency-Key is required; repeating the same key replays the first response.',
  ],
  example: {
    request: { use_proposals: true, confidence_threshold: 0.9 },
    response: {
      data: {
        dry_run: false,
        considered: 2,
        applied: [
          { external_id: '33333333-3333-4333-8333-333333333333', journal_entry_id: '44444444-4444-4444-8444-444444444444', via: 'line' },
        ],
        skipped: [
          {
            pair: { external_ids: ['55555555-5555-4555-8555-555555555555'], journal_entry_ids: ['66666666-6666-4666-8666-666666666666'] },
            code: 'ALREADY_LINKED',
            message: 'Verifikatet är redan kopplat till en annan skattekonto-transaktion.',
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reconciliation:write',
  risk: 'medium',
  idempotent: false,
  reversible: true,
  dryRunSupported: true,
  request: { body: LinksRequest },
  response: { success: dataEnvelope(LinksResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; accountKey: string }> }>(
  'reconciliation.accounts.links.create',
  async (request, ctx, params) => {
    const { accountKey } = await params.params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'accountKey', message: 'Okänt konto.' },
      })
    }
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = LinksRequest.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      })
    }
    try {
      const result = await matchPairs(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        accountKey,
        parsed.data,
        { dryRun: ctx.dryRun },
      )
      if (!result) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'accountKey', message: 'Okänt konto för det här företaget.' },
        })
      }
      if (ctx.dryRun) {
        return dryRunPreview(result, { requestId: ctx.requestId, log: ctx.log })
      }
      return ok(result, { requestId: ctx.requestId })
    } catch (err) {
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
