/**
 * POST /api/v1/companies/{companyId}/salary/vacation-year-close
 *
 * Semesterberedning + semesterårsavslut in one verb (payroll gap-closure
 * 3.4). dry_run returns the FULL review report (per-employee day
 * transitions + the SEK reconcile) without writing; the live call closes
 * the year's ledger rows, rolls balances into the next year (min-20 floor,
 * 5-year expiry -> forced payout), and books one drift-adjustment
 * verifikation on 7290/2920 + 7519/2940 when |drift| > 1 kr.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import {
  commitVacationYearClose,
  previewVacationYearClose,
} from '@/lib/salary/semesterberedning'
import { getVacationYearBasis } from '@/lib/salary/vacation-ledger'
import { getClosableYearStart } from '@/lib/salary/vacation-year'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD date format')

const CloseBody = z.object({
  /** Defaults to the most recently ENDED vacation year per the company's
   * basis setting. */
  vacation_year_start: isoDate.optional(),
  /** Book the 2920/2940 drift adjustment (default true). False = roll the
   * days but leave the SEK reconcile for a manual verifikat. */
  book_adjustment: z.boolean().default(true),
})

const CloseResponse = z.object({
  vacation_year_closure_id: z.string().uuid(),
  adjustment_entry_id: z.string().uuid().nullable(),
  report: z.unknown(),
})

registerEndpoint({
  operation: 'salary.vacation-year-close',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary/vacation-year-close',
  summary: 'Close a vacation year (semesterberedning + arsavslut).',
  description:
    'Rolls every active employee\'s vacation balances into the next year (only days above the 20-day must-take floor are saved; saved days older than 5 years become forced payouts) and reconciles the day-valued semesterlöneskuld against the booked 2920/2940, posting one adjustment verifikation when drift exceeds 1 kr. The frozen report is stored with the closure (BFL 7 kap).',
  useWhen:
    'Once per year after the vacation year ends (Jan for calendar basis, Apr for statutory). ALWAYS dry-run first and review the report: the close is not reversible via API.',
  doNotUseFor:
    'Mid-year balance corrections (fix the source: absence days, opening balances, or run corrections). Paying out expired days (create a semesterersattning line in the next salary run: the close only flags them).',
  pitfalls: [
    'dry_run=true returns the full review report with zero writes: treat it as mandatory before the live call.',
    '409 VACATION_YEAR_ALREADY_CLOSED on replay: the closure row is the idempotency anchor.',
    '423-style PERIOD_LOCKED when the adjustment date falls in a locked period: unlock or close without adjustment (book_adjustment=false) and post manually.',
    'Untaken days at or below the 20-day floor are flagged in the report, NOT auto-saved (Semesterlagen 18 §).',
  ],
  example: {
    request: { book_adjustment: true },
    response: {
      data: {
        vacation_year_closure_id: 'vyc_a1b2…',
        adjustment_entry_id: 'je_c3d4…',
        report: { vacation_year_start: '2025-01-01', rows: [], sek: { drift_2920: 8690.84 } },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: CloseBody },
  response: { success: dataEnvelope(CloseResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'salary.vacation-year-close',
  async (request, ctx) => {
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

    const parsed = CloseBody.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    let yearStart = parsed.data.vacation_year_start
    if (!yearStart) {
      const basis = await getVacationYearBasis(ctx.supabase, ctx.companyId!)
      yearStart = getClosableYearStart(new Date().toISOString().slice(0, 10), basis)
    }

    if (ctx.dryRun) {
      const preview = await previewVacationYearClose(ctx.supabase, ctx.companyId!, yearStart)
      if (!preview.ok) {
        return v1ErrorResponseFromCode(preview.code, ctx.log, {
          requestId: ctx.requestId,
          details: preview.details,
        })
      }
      return dryRunPreview(
        { vacation_year_closure_id: null, adjustment_entry_id: null, report: preview.data },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const result = await commitVacationYearClose(ctx.supabase, ctx.companyId!, ctx.userId, yearStart, {
      bookAdjustment: parsed.data.book_adjustment,
    })
    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    return ok(
      {
        vacation_year_closure_id: result.data.closure_id,
        adjustment_entry_id: result.data.adjustment_entry_id,
        report: result.data.report,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
