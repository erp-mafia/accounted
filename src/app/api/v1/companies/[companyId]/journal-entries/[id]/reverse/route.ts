/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/reverse
 *
 * Storno: posts a reversing journal entry that nullifies the original.
 * The original stays in place: a posted verifikation is corrected through a
 * rättelse that keeps it visible, never overwritten (BFL 5 kap 5 §);
 * the reversal carries `reverses_id` back to it and the original is annotated
 * with `reversed_by_id`. Both entries remain visible in the verifikationsserie.
 *
 * Optional body: `{ reversal_date?: ISO date, allow_deep_chain?: boolean }`.
 * reversal_date defaults to the original's entry_date and must lie inside the
 * original's fiscal year (the storno is numbered and booked there, see
 * lib/core/bookkeeping/storno-target.ts); allow_deep_chain overrides the
 * correction-chain depth guard (CORRECTION_CHAIN_TOO_DEEP at 3+ levels).
 *
 * Idempotent (mandatory Idempotency-Key).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import type { ApiV1Context } from '@/lib/api/v1/with-api-v1'
import { voucherStornoBusinessEvent } from '@/lib/bookkeeping/ledger-business-events'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { correctionChainDepth, CORRECTION_CHAIN_GUARD_DEPTH } from '@/lib/core/bookkeeping/correction-chain'
import { assertStornoTarget } from '@/lib/core/bookkeeping/storno-target'
import {
  CorrectionChainTooDeepError,
  isBookkeepingError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
} from '@/lib/bookkeeping/errors'

const ReverseRequest = z
  .object({
    reversal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'reversal_date must be ISO YYYY-MM-DD').optional(),
    // Explicit override of the correction-chain depth guard: reversing an
    // entry 3+ links deep in a rättelse chain returns
    // CORRECTION_CHAIN_TOO_DEEP without it.
    allow_deep_chain: z.boolean().optional(),
  })
  .strict()

const JournalEntryReversed = z.object({
  reversal_id: z.string().uuid(),
  original_id: z.string().uuid(),
  voucher_series: z.string(),
  voucher_number: z.number().int(),
  entry_date: z.string(),
  status: z.literal('posted'),
})

registerEndpoint({
  operation: 'journal-entries.reverse',
  method: 'POST',
  path: '/api/v1/companies/:companyId/journal-entries/:id/reverse',
  summary: 'Storno a posted journal entry.',
  description:
    'Creates a reversing journal entry that nullifies the original. The original remains posted and visible: the reversal links via reverses_id and the original is annotated reversed_by_id. The reversal carries its own voucher_number in the same series and is booked into the original\'s fiscal year, so the löpnummer chain stays unbroken (BFL 5 kap 5-7 §§).',
  useWhen:
    'A posted entry needs to be cancelled and there is no replacement coming: e.g. a duplicate booking, an entry posted to the wrong period. Use /correct instead when you need to replace the entry with corrected lines.',
  doNotUseFor:
    'Cancelling a draft (drafts have no voucher_number: use DELETE /journal-entries/{id}). Reversing an already-reversed entry (returns ENTRY_ALREADY_REVERSED).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'reversal_date defaults to the original entry\'s date. The reversal is numbered and booked in the original\'s fiscal year, so a reversal_date outside that year returns 400 ENTRY_DATE_OUTSIDE_FISCAL_PERIOD.',
    'A locked or closed fiscal year, or a date on or before the company lock date, returns PERIOD_LOCKED (details.reason) before any voucher number is drawn; a dry run gives the same verdict. Unlock a locked year with POST /fiscal-periods/{id}/unlock. A closed year stays as it is: book a correcting entry in the open year instead (POST /journal-entries).',
    'You cannot reverse a draft (status must be posted). Use /correct after commit if the original needs replacing.',
    'Reversing an entry 3+ links deep in a correction chain returns CORRECTION_CHAIN_TOO_DEEP (409). Book ONE net-effect correction instead, or pass allow_deep_chain=true to override.',
  ],
  example: {
    request: { reversal_date: '2026-05-13' },
    response: {
      data: {
        reversal_id: '4d2a…', original_id: '0e9c…',
        voucher_series: 'A', voucher_number: 144, entry_date: '2026-05-13', status: 'posted',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: ReverseRequest },
  response: { success: dataEnvelope(JournalEntryReversed) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'journal-entries.reverse',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Journal entry id must be a UUID.' },
      })
    }
    const entryId = idParse.data

    let bodyReversalDate: string | undefined
    let bodyAllowDeepChain = false
    let rawBody: unknown = null
    try {
      const text = await request.text()
      if (text.trim()) rawBody = JSON.parse(text)
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    if (rawBody) {
      const parsed = ReverseRequest.safeParse(rawBody)
      if (!parsed.success) return v1ValidationError(ctx, parsed.error)
      bodyReversalDate = parsed.data.reversal_date
      bodyAllowDeepChain = parsed.data.allow_deep_chain === true
    }

    // Pre-flight: confirm the original exists, is posted, and not already reversed.
    const { data: original, error: fetchErr } = await ctx.supabase
      .from('journal_entries')
      .select('id, status, entry_date, fiscal_period_id, reversed_by_id, voucher_series, voucher_number, correction_of_id, reverses_id')
      .eq('company_id', ctx.companyId!)
      .eq('id', entryId)
      .maybeSingle()

    if (fetchErr) return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    if (!original) {
      return v1ErrorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    const typed = original as {
      id: string
      status: string
      entry_date: string
      fiscal_period_id: string
      reversed_by_id: string | null
      correction_of_id: string | null
      reverses_id: string | null
    }
    if (typed.status !== 'posted') {
      return v1ErrorResponseFromCode('CANNOT_REVERSE_NON_POSTED', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: typed.status },
      })
    }
    if (typed.reversed_by_id) {
      return v1ErrorResponseFromCode('ENTRY_ALREADY_REVERSED', ctx.log, {
        requestId: ctx.requestId,
        details: { existing_reversal_id: typed.reversed_by_id },
      })
    }

    // Where the storno lands: the original's year, on the original's date
    // unless one inside that year is asked for, and the year must be open.
    // The engine's own check (reverseEntry), run here too so the dry run gives
    // the real verdict. It used to default to today and lock-check today's
    // period: a storno numbered in last year's series came out dated this
    // year, and a locked year burned a voucher number at the trigger.
    let reversalDate: string
    try {
      reversalDate = await assertStornoTarget(ctx.supabase, ctx.companyId!, typed, bodyReversalDate)
    } catch (err) {
      const refused = await periodLockedResponse(ctx, err, typed.fiscal_period_id)
      if (refused) return refused
      if (isBookkeepingError(err)) return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
      throw err
    }

    // Chain-depth guard BEFORE the dry-run return: a dry run must give the
    // same verdict the real execution would. reverseEntry re-checks on the
    // real path.
    if (!bodyAllowDeepChain) {
      const chain = await correctionChainDepth(ctx.supabase, ctx.companyId!, typed)
      if (chain.depth >= CORRECTION_CHAIN_GUARD_DEPTH) {
        return v1ErrorResponse(
          new CorrectionChainTooDeepError(chain.depth, chain.rootVoucher),
          ctx.log,
          { requestId: ctx.requestId },
        )
      }
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          original_id: entryId,
          reversal_date: reversalDate,
          would_create_reversal_with_status: 'posted',
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    try {
      // Posting port (step 2i): ledger.storno of the verifikat while
      // POSTING_EVENTS is on, client_asserted on a key.
      const reversal = await postingPort.reverseJournalEntry({
        supabase: ctx.supabase,
        companyId: ctx.companyId!,
        userId: ctx.userId,
        entryId,
        reversalDate,
        options: { allowDeepChain: bodyAllowDeepChain },
        event: () => voucherStornoBusinessEvent({ entryId, occurredOn: todayIsoStockholm(), linkBasis: linkBasisColumns('user_created') }),
        role: 'reversal',
      })
      return ok(
        {
          reversal_id: reversal.id,
          original_id: entryId,
          voucher_series: reversal.voucher_series,
          voucher_number: reversal.voucher_number,
          entry_date: reversal.entry_date,
          status: 'posted' as const,
        },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      // The year was locked between the pre-flight and the engine's own check.
      const refused = await periodLockedResponse(ctx, err, typed.fiscal_period_id)
      if (refused) return refused
      if (isBookkeepingError(err)) {
        return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
      }
      ctx.log.error('journal-entries.reverse failed', err as Error, { entryId })
      return v1ErrorResponseFromCode('BOOKKEEPING_DATABASE_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'reverse' },
      })
    }
  },
  { requireIdempotencyKey: true },
)

/**
 * The storno target check's lock refusals in v1's documented PERIOD_LOCKED
 * shape (details.reason from checkPeriodLock, the layer that locked the date).
 * Null for any other error.
 */
async function periodLockedResponse(ctx: ApiV1Context, err: unknown, fiscalPeriodId: string) {
  if (!(err instanceof TargetPeriodClosedError) && !(err instanceof TargetPeriodLockedError)) return null
  const verdict = await checkPeriodLock(ctx.supabase, ctx.companyId!, err.date)
  const fallback = err instanceof TargetPeriodClosedError ? 'period_is_closed' : 'period_locked_at_set'
  return v1ErrorResponseFromCode('PERIOD_LOCKED', ctx.log, {
    requestId: ctx.requestId,
    details: {
      reason: verdict.locked ? verdict.reason : fallback,
      fiscal_period_id: fiscalPeriodId,
      reversal_date: err.date,
    },
  })
}
