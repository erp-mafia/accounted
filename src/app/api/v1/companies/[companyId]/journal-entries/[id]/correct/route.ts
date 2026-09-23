/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/correct
 *
 * 3-step correction flow per Bokföringslagen (BFL 5 kap 5 §): the original
 * stays posted, a storno reversal nullifies it, and a corrected entry is
 * posted with the new lines. All three remain in the verifikationsserie,
 * linked via reverses_id, reversed_by_id, and correction_of_id.
 *
 * Body: `{ lines: [...], description?, allow_deep_chain? }`: the new balanced
 * lines. The corrected entry inherits entry_date, fiscal_period_id, and
 * voucher_series from the original. Its description defaults to
 * "Rättelse: <original>"; pass `description` to override it (e.g. when the
 * original label named the wrong account). `allow_deep_chain` bypasses the
 * correction-chain depth guard (CORRECTION_CHAIN_TOO_DEEP at 3+ levels).
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { CorrectJournalEntrySchema } from '@/lib/api/schemas'
import { validateBalance } from '@/lib/bookkeeping/engine'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import { correctionChainDepth, CORRECTION_CHAIN_GUARD_DEPTH } from '@/lib/core/bookkeeping/correction-chain'
import { CorrectionChainTooDeepError, isBookkeepingError } from '@/lib/bookkeeping/errors'

const JournalEntryCorrected = z.object({
  reversal_id: z.string().uuid(),
  corrected_id: z.string().uuid(),
  original_id: z.string().uuid(),
  voucher_series: z.string(),
  reversal_voucher_number: z.number().int(),
  corrected_voucher_number: z.number().int(),
})

registerEndpoint({
  operation: 'journal-entries.correct',
  method: 'POST',
  path: '/api/v1/companies/:companyId/journal-entries/:id/correct',
  summary: 'Correct a posted journal entry (BFL 5:5 storno-then-replace).',
  description:
    'Per Bokföringslagen 5 kap 5 §, posted entries cannot be modified. This endpoint creates the canonical correction trail: a storno reversing the original, then a new entry with the corrected lines. All three are visible in the verifikationsserie and linked via reverses_id / reversed_by_id / correction_of_id. Idempotent. Dry-runnable.',
  useWhen:
    'You need to amend a posted verifikation. Use this rather than /reverse when the entry is being REPLACED with new lines: /reverse just nullifies.',
  doNotUseFor:
    'Drafts (no voucher_number: cancel via dashboard). Already-corrected entries (the chain only supports one correction; correct the latest in the chain).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'The new lines must balance. JOURNAL_ENTRY_NOT_BALANCED if not.',
    'The original\'s entry_date and fiscal_period_id are inherited. If the original\'s period has been locked since posting, the call returns PERIOD_LOCKED.',
    'Three voucher numbers are advanced in this call: the original (already burned), the reversal, and the corrected. The series stays unbroken.',
    'A chain 3+ corrections deep returns CORRECTION_CHAIN_TOO_DEEP (409). Compute the net effect of the whole chain and book ONE correction, or pass allow_deep_chain=true to override.',
  ],
  example: {
    request: {
      lines: [
        { account_number: '6570', debit_amount: 75, credit_amount: 0, line_description: 'Bankavgift (rättad)' },
        { account_number: '1930', debit_amount: 0, credit_amount: 75, line_description: 'Företagskonto' },
      ],
    },
    response: {
      data: {
        reversal_id: '4d2a…',
        corrected_id: '7b3a…',
        original_id: '0e9c…',
        voucher_series: 'A',
        reversal_voucher_number: 144,
        corrected_voucher_number: 145,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: CorrectJournalEntrySchema },
  response: { success: dataEnvelope(JournalEntryCorrected) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'journal-entries.correct',
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

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body
    const parsed = CorrectJournalEntrySchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const { lines, description, allow_deep_chain } = parsed.data

    const balance = validateBalance(lines)
    if (!balance.valid) {
      return v1ErrorResponseFromCode('JOURNAL_ENTRY_NOT_BALANCED', ctx.log, {
        requestId: ctx.requestId,
        details: { total_debit: balance.totalDebit, total_credit: balance.totalCredit },
      })
    }

    // Pre-flight: confirm the original is posted (storno-service throws
    // CANNOT_CORRECT_NON_POSTED otherwise but we want the structured envelope).
    const { data: original, error: fetchErr } = await ctx.supabase
      .from('journal_entries')
      .select('id, status, entry_date, voucher_series, correction_of_id, reverses_id')
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
      voucher_series: string
      correction_of_id: string | null
      reverses_id: string | null
    }
    if (typed.status !== 'posted') {
      return v1ErrorResponseFromCode('CANNOT_CORRECT_NON_POSTED', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: typed.status },
      })
    }

    // Chain-depth guard BEFORE the dry-run return: a dry run must give the
    // same verdict the real execution would, so a depth-3 chain without the
    // override reports CORRECTION_CHAIN_TOO_DEEP here too. correctEntry
    // re-checks on the real path.
    if (!allow_deep_chain) {
      const chain = await correctionChainDepth(ctx.supabase, ctx.companyId!, typed)
      if (chain.depth >= CORRECTION_CHAIN_GUARD_DEPTH) {
        return v1ErrorResponse(
          new CorrectionChainTooDeepError(chain.depth, chain.rootVoucher),
          ctx.log,
          { requestId: ctx.requestId },
        )
      }
    }

    // Period-lock pre-check on the INHERITED entry_date. /reverse already has
    // this guard against its `reversal_date`; /correct must match because
    // both the storno and the corrected entry land on typed.entry_date and
    // either fails the engine if the period is locked. Returning the
    // structured PERIOD_LOCKED here beats letting the engine throw a Swedish
    // string that falls through to BOOKKEEPING_DATABASE_ERROR.
    const lockVerdict = await checkPeriodLock(ctx.supabase, ctx.companyId!, typed.entry_date)
    if (lockVerdict.locked) {
      return v1ErrorResponseFromCode('PERIOD_LOCKED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: lockVerdict.reason,
          fiscal_period_id: lockVerdict.fiscal_period_id,
          entry_date: typed.entry_date,
        },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          original_id: entryId,
          would_create_reversal: true,
          would_create_corrected: true,
          voucher_series: typed.voucher_series,
          inherited_entry_date: typed.entry_date,
          new_lines_balance: { debit: balance.totalDebit, credit: balance.totalCredit },
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    try {
      const { reversal, corrected } = await correctEntry(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        entryId,
        lines,
        { description, allowDeepChain: allow_deep_chain },
      )
      return ok(
        {
          reversal_id: reversal.id,
          corrected_id: corrected.id,
          original_id: entryId,
          voucher_series: corrected.voucher_series,
          reversal_voucher_number: reversal.voucher_number,
          corrected_voucher_number: corrected.voucher_number,
        },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      if (isBookkeepingError(err)) {
        return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
      }
      ctx.log.error('journal-entries.correct failed', err as Error, { entryId })
      return v1ErrorResponseFromCode('BOOKKEEPING_DATABASE_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'correct' },
      })
    }
  },
  { requireIdempotencyKey: true },
)
