/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/reverse
 *
 * Storno: posts a reversing journal entry that nullifies the original.
 * The original stays in place (posted entries are immutable per BFL 5 kap 2 §);
 * the reversal carries `reverses_id` back to it and the original is annotated
 * with `reversed_by_id`. Both entries remain visible in the verifikationsserie.
 *
 * Optional body: `{ reversal_date?: ISO date }`. Defaults to today.
 *
 * Idempotent (mandatory Idempotency-Key).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'

const ReverseRequest = z
  .object({
    reversal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'reversal_date must be ISO YYYY-MM-DD').optional(),
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
    'Creates a reversing journal entry that nullifies the original. The original remains posted and visible: the reversal links via reverses_id and the original is annotated reversed_by_id. The reversal carries its own voucher_number in the same series so the löpnummer chain stays unbroken (BFL 5 kap 5-7 §§).',
  useWhen:
    'A posted entry needs to be cancelled and there is no replacement coming: e.g. a duplicate booking, an entry posted to the wrong period. Use /correct instead when you need to replace the entry with corrected lines.',
  doNotUseFor:
    'Cancelling a draft (drafts have no voucher_number; cancel via the dashboard). Reversing an already-reversed entry (returns ENTRY_ALREADY_REVERSED).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'reversal_date defaults to today; the reversal is posted in the fiscal period covering that date. If today\'s period is locked the call returns PERIOD_LOCKED.',
    'You cannot reverse a draft (status must be posted). Use /correct after commit if the original needs replacing.',
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
      if (!parsed.success) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        })
      }
      bodyReversalDate = parsed.data.reversal_date
    }

    const today = new Date().toISOString().split('T')[0]
    const reversalDate = bodyReversalDate || today

    // Period-lock on the reversal date. Engine + DB trigger are still
    // authoritative; this gives a structured error instead of a 500.
    const lockVerdict = await checkPeriodLock(ctx.supabase, ctx.companyId!, reversalDate)
    if (lockVerdict.locked) {
      return v1ErrorResponseFromCode('PERIOD_LOCKED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: lockVerdict.reason, fiscal_period_id: lockVerdict.fiscal_period_id, reversal_date: reversalDate },
      })
    }

    // Pre-flight: confirm the original exists, is posted, and not already reversed.
    const { data: original, error: fetchErr } = await ctx.supabase
      .from('journal_entries')
      .select('id, status, reversed_by_id, voucher_series, voucher_number')
      .eq('company_id', ctx.companyId!)
      .eq('id', entryId)
      .maybeSingle()

    if (fetchErr) return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    if (!original) {
      return v1ErrorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    const typed = original as { id: string; status: string; reversed_by_id: string | null }
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
      const reversal = await reverseEntry(ctx.supabase, ctx.companyId!, ctx.userId, entryId, reversalDate)
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
