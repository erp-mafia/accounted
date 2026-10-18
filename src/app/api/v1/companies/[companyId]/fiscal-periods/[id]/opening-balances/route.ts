/**
 * POST /api/v1/companies/{companyId}/fiscal-periods/{id}/opening-balances
 *
 * Generates the opening-balance verifikation for the next period from the
 * closed period's trial balance (BAS class 1-2 accounts with non-zero
 * closing balance). Wraps lib/core/bookkeeping/year-end-service.generateOpeningBalances.
 * Synchronous.
 *
 * URL param `id` is the CLOSED period; body field next_period_id is the
 * target where the IB entry lands.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { ownsFiscalPeriod } from '@/lib/api/v1/owns-fiscal-period'
import { generateOpeningBalances } from '@/lib/core/bookkeeping/year-end-service'
import { OpeningBalanceExistsError } from '@/lib/import/opening-balance/existing'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { linkBasisColumns } from '@/lib/links/stamp'

const Body = z.object({ next_period_id: z.string().uuid() }).strict()

const OpeningBalancesResponse = z.object({
  opening_entry_id: z.string().uuid(),
  voucher_series: z.string(),
  voucher_number: z.number().int(),
  next_period_id: z.string().uuid(),
})

registerEndpoint({
  operation: 'fiscal-periods.opening-balances',
  method: 'POST',
  path: '/api/v1/companies/:companyId/fiscal-periods/:id/opening-balances',
  summary: 'Generate opening-balance verifikation for the next fiscal period.',
  description:
    'Reads the closed period\'s trial balance, filters to BAS class 1-2 accounts with non-zero closing balance, and posts an opening verifikation (status=posted) onto the next_period_id. Sync. The path id is the CLOSED period; body.next_period_id is the target.',
  useWhen:
    'Rarely: /year-end already generates the next year\'s IB. Use this only to carry a closed period\'s UB into a next year that has no IB yet (e.g. a year closed outside the year-end flow).',
  doNotUseFor:
    'Typing opening balances by hand (POST /fiscal-periods/{id}/opening-balances/manual) or correcting an IB (POST /fiscal-periods/{id}/opening-balances/correct). Re-running on the same target period (refused with 409 CONFLICT, details.reason opening_balance_already_posted).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'next_period_id must reference the SAME company and must NOT already have an IB: the period\'s linked IB or any posted source_type=opening_balance verifikat. Otherwise 409 CONFLICT with details.reason opening_balance_already_posted and details.existing_entry_id; nothing is posted. A reversed (stornoed) IB does not count.',
    'Only class 1 (assets) and 2 (equity/liabilities) flow into the IB; class 3-8 are zeroed by the closing entry.',
  ],
  example: {
    request: { next_period_id: '7b3a…' },
    response: {
      data: { opening_entry_id: '4d2a…', voucher_series: 'A', voucher_number: 1, next_period_id: '7b3a…' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: true,
  dryRunSupported: false,
  request: { body: Body },
  response: { success: dataEnvelope(OpeningBalancesResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'fiscal-periods.opening-balances',
  async (request, ctx, params) => {
    const { id: closedPeriodId } = await params.params
    const idParse = z.string().uuid().safeParse(closedPeriodId)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'closed_period id must be a UUID.' },
      })
    }

    let rawBody: unknown
    try { rawBody = await request.json() }
    catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = Body.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    // Ownership pre-check on BOTH ids: the closed period (URL) and the next
    // period (body). The wrapper has already verified the user's membership
    // in companyId, but the period ids themselves come from caller input
    // and need to be confirmed to belong to that company before the engine
    // call.
    if (!(await ownsFiscalPeriod(ctx.supabase, ctx.companyId!, idParse.data))) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'fiscal_period', field: 'id' },
      })
    }
    if (!(await ownsFiscalPeriod(ctx.supabase, ctx.companyId!, parsed.data.next_period_id))) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'fiscal_period', field: 'next_period_id' },
      })
    }

    // A year that already has an IB is refused by generateOpeningBalances
    // itself (assertNoOpeningBalance, before anything is posted), the same
    // check every IB writer runs; mapped to CONFLICT below.
    try {
      const entry = await generateOpeningBalances(
        ctx.supabase, ctx.companyId!, ctx.userId,
        idParse.data, parsed.data.next_period_id,
        // The posting port's event, while POSTING_EVENTS is on: the client booked the IB.
        () => ({ linkBasis: linkBasisColumns('user_created') }),
      )
      return ok(
        {
          opening_entry_id: entry.id,
          voucher_series: entry.voucher_series,
          voucher_number: entry.voucher_number,
          next_period_id: parsed.data.next_period_id,
        },
        { requestId: ctx.requestId },
      )
    } catch (err) {
      // `executeYearEndClosing` already generates the IB, so a separate call
      // after /year-end lands here: CONFLICT, so the caller can inspect what
      // is already there.
      if (err instanceof OpeningBalanceExistsError) {
        return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
          requestId: ctx.requestId,
          details: {
            reason: 'opening_balance_already_posted',
            next_period_id: parsed.data.next_period_id,
            existing_entry_id: err.existing.journal_entry_id,
            remediation:
              '/year-end already generates the opening balance entry. If you ran /year-end first, no further call is needed. Inspect existing IB via GET /journal-entries?fiscal_period_id={next_period_id}&source_type=opening_balance.',
          },
        })
      }
      const msg = err instanceof Error ? err.message : 'unknown'
      ctx.log.warn('opening-balances refused', { reason: msg })
      if (msg.includes('not found')) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId, details: { resource: 'fiscal_period' },
        })
      }
      return v1ErrorResponseFromCode('BOOKKEEPING_DATABASE_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: getErrorMessage(err, { locale: 'en' }), step: 'opening_balances' },
      })
    }
  },
  { requireIdempotencyKey: true },
)
