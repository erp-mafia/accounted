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
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { ownsFiscalPeriod } from '@/lib/api/v1/owns-fiscal-period'
import { generateOpeningBalances } from '@/lib/core/bookkeeping/year-end-service'

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
    'After /year-end + /close on a period, generate the IB into the next period so the new year starts with the correct balance sheet.',
  doNotUseFor:
    'Posting opening balances on a manually-edited basis (use POST /journal-entries with source_type=manual). Re-running on the same target period (will produce duplicate IB entries).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'next_period_id must reference the SAME company and must NOT already have an IB entry. The engine throws if it does.',
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
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      })
    }

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

    // Duplicate IB detection. `executeYearEndClosing` generates the opening
    // balance entry as part of its own flow (see YearEndResult.openingBalance-
    // Entry on the year-end route's result mapping). If a caller separately
    // hits this endpoint after year-end ran, the engine would silently post
    // a SECOND IB into the next period, doubling the equity. Reject up front
    // with CONFLICT so the caller can inspect what's already there.
    const { count: existingIbCount } = await ctx.supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', ctx.companyId!)
      .eq('fiscal_period_id', parsed.data.next_period_id)
      .eq('source_type', 'opening_balance')
      .neq('status', 'cancelled')
    if ((existingIbCount ?? 0) > 0) {
      return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: 'opening_balance_already_posted',
          next_period_id: parsed.data.next_period_id,
          remediation:
            '/year-end already generates the opening balance entry. If you ran /year-end first, no further call is needed. Inspect existing IB via GET /journal-entries?fiscal_period_id={next_period_id}&source_type=opening_balance.',
        },
      })
    }

    try {
      const entry = await generateOpeningBalances(
        ctx.supabase, ctx.companyId!, ctx.userId,
        idParse.data, parsed.data.next_period_id,
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
      const msg = err instanceof Error ? err.message : 'unknown'
      ctx.log.warn('opening-balances refused', { reason: msg })
      if (msg.includes('not found')) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId, details: { resource: 'fiscal_period' },
        })
      }
      return v1ErrorResponseFromCode('BOOKKEEPING_DATABASE_ERROR', ctx.log, {
        requestId: ctx.requestId, details: { reason: msg, step: 'opening_balances' },
      })
    }
  },
  { requireIdempotencyKey: true },
)
