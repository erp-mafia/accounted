/**
 * POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/links
 *
 * Link outside rows to existing verifikat on one account, or, on a bank
 * account, settle verifikat with no outside row against each other. Pairs,
 * or the persisted proposals. Writes nothing to the ledger: a link only
 * points a row at a verifikat, so it is allowed in locked periods and
 * reversible by DELETE .../links/{linkId}. Dry-runnable; Idempotency-Key
 * required.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import {
  AccountKeySchema,
  ReconciliationPairSchema as PairSchema,
  reconciliationLinksBodyFields,
  reconciliationLinksBodyRefinement,
} from '@/lib/reconciliation/schemas'
import { matchPairs } from '@/lib/reconciliation/actions'

const LinksRequest = z.object(reconciliationLinksBodyFields).refine(...reconciliationLinksBodyRefinement)

const LinksResponse = z.object({
  dry_run: z.boolean(),
  considered: z.number().int(),
  applied: z.array(
    z.object({
      external_id: z.string(),
      journal_entry_id: z.string(),
      via: z.enum(['line', 'entry_total', 'lines', 'partial']).optional(),
      allocated_amount: z.number().optional(),
      remainder_amount: z.number().optional(),
    }),
  ),
  /** Pairs without outside rows: verifikat settled against each other on a bank account. */
  settled: z.array(
    z.object({
      /** Null on a dry run. Undo with DELETE .../links/{settlement_id}. */
      settlement_id: z.string().nullable(),
      account_number: z.string(),
      entries: z.array(
        z.object({
          journal_entry_id: z.string(),
          voucher_series: z.string().nullable(),
          voucher_number: z.number().int().nullable(),
          entry_date: z.string(),
          /** What the verifikat leaves open on the account, debit positive; the entries sum to zero. */
          amount: z.number(),
        }),
      ),
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
    'Body: { pairs: [{ external_ids: [id], journal_entry_ids: [id], allocations? }] } and/or { use_proposals: true, confidence_threshold? }. Each pair is validated as the single-link paths validate (row open and not ignored, entry posted and not reversed, the entry\'s account lines settle the amount, entry not already linked) and applied independently: the response lists applied[] and skipped[{pair, code, message}] so partial success is explicit. On a bank account a pair may also be ONE transaction against SEVERAL verifikat (1:N): allocations[{journal_entry_id, amount}] gives the signed slice per verifikat (omitted: each slice defaults to the voucher\'s line on the account); the slices must sum to the transaction amount, and each applied link then carries allocated_amount. On the skattekonto a pair may carry allow_remainder: true to link rows to a summarised verifikat whose 1630 movement they do not settle (one year-end or month-end verifikat that books more events than these, some from before the fetched history): the link is then via "partial", and remainder_amount on each applied link is what the verifikat still holds on 1630 beyond the rows linked to it (ledger sign, either sign); it stays in unmatched_ledger with that amount. remainder_amount is also returned when a row settles one of several 1630 lines of a verifikat. On the skattekonto a pair may also be ONE row against SEVERAL verifikat whose open amounts on 1630 sum exactly to the event (a verifikat and the correction booked after it): each applied link carries via "split" and allocated_amount (that verifikat\'s whole open amount; allocations, when sent, must equal it), the verifikat leave unmatched_ledger together and are listed under matched with a settlement, and unlinking the row undoes it all. On a SEK bank account a pair may also carry NO external_ids and two or more journal_entry_ids: verifikat that take each other out on the account (a wrong verifikat and the correction booked by hand), each still without a bank row and summing to exactly zero; they leave unmatched_ledger together and are reported in settled[] with a settlement_id. Codes: UNSUPPORTED_PAIR_SHAPE, ALREADY_LINKED, ENTRY_NOT_FOUND, ENTRY_REVERSED, PAIR_NOT_CLOSED, ROW_IGNORED, NOT_FOUND, LINK_RACE, ENTRY_NOT_OPEN (a verifikat of a ledger-only pair already has a bank row, has no line on the account, or is an opening balance or a storno; for a skattekonto 1:N, the verifikat is not in the open 1630 list), ALREADY_SETTLED, BANK_ANCHOR_REFUSED (the database refused the link: a verifikat does not book the row, or its 1:N slice, on the bank ledger in that direction; retrying unchanged will not help). ?dry_run=true returns the pairs that would be attempted without writing (a 1:N dry run resolves the slices).',
  useWhen:
    'An agent or integration has decided which rows explain each other, or wants to apply the proposals the sync already computed.',
  doNotUseFor:
    'Booking new verifikat for rows that have no counterpart (use the transactions or skattekonto booking endpoints); reconciling across accounts.',
  pitfalls: [
    'A pair is one OR MANY outside rows against exactly one verifikat (bank: independent links per transaction; skattekonto: all-or-nothing, the rows must sum to what the verifikat settles), or ONE outside row against SEVERAL verifikat (all-or-nothing; bank: the slices must sum to the transaction; skattekonto: the verifikat\'s open amounts on 1630 must sum exactly to the event, no allow_remainder). Several rows against several verifikat are UNSUPPORTED_PAIR_SHAPE, never silently reduced.',
    'A pair must close to the row\'s amount on the expected side (a single matching line, or the entry\'s lines on the account netting to it); a fee or rounding difference is PAIR_NOT_CLOSED here and needs a residual booking first.',
    'Skattekonto rows against a summarised verifikat never close: PAIR_NOT_CLOSED names both sums and the remainder. Repeat the pair with allow_remainder: true only when the verifikat really books those events; a dry run shows remainder_amount first. The link never changes unexplained_difference: the rows leave unmatched_external and the same amount leaves the verifikat.',
    'Links never touch the ledger, so they succeed in locked periods; unlink with DELETE .../links/{linkId} (linkId = the outside row id, or the settlement_id of a ledger-only pair).',
    'A ledger-only pair (no external_ids) is never proposed and never applied by use_proposals: two verifikat of opposite amounts are not necessarily a correction of each other, so name them explicitly. It books nothing: a verifikat that is wrong and has no correction yet still needs one.',
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
        settled: [],
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
    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body
    const parsed = LinksRequest.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
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
