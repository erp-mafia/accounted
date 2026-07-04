/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/mark-paid
 *
 * Mirrors the dashboard's `/paid` route: advances status `approved` → `paid`
 * and stamps `paid_at`. No engine interaction, no event emission (the dashboard's
 * route is also silent; the verifikation event fires from `:book`).
 *
 * Idempotent at the call level: a replay with the same Idempotency-Key returns
 * the cached response. State-wise, calling :mark-paid on an already-paid run
 * returns 400 (status must be approved).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const SalaryRunPaid = z.object({
  id: z.string().uuid(),
  status: z.literal('paid'),
  paid_at: z.string(),
})

const MARK_PAID_COLUMNS = 'id, status, paid_at'

registerEndpoint({
  operation: 'salary-runs.mark-paid',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs/:id/mark-paid',
  summary: 'Mark an approved salary run as paid.',
  description:
    'Advances a salary run from `approved` to `paid` and stamps `paid_at`. This is the state-change verb after the bank transfer (or autogiro file) has been processed; it does NOT initiate payment, and does NOT post journal entries (use `:book` after this for that).',
  useWhen:
    'You\'ve confirmed the salary payment hit employee bank accounts and want to advance the run\'s lifecycle so `:book` can post the verifikation.',
  doNotUseFor:
    'Initiating the actual bank transfer (the v1 API does not yet expose payment-file generation; use the dashboard\'s payment-file endpoints). Posting journal entries (use `:book`). Reverting a paid run (no `:unpaid` exists: call `:correct` once booked if you need to undo).',
  pitfalls: [
    'Run must be in `approved`: non-`approved` runs return 400 SALARY_RUN_MARK_PAID_NOT_APPROVED.',
    'paid_at is set server-side to the current UTC timestamp; the API does not accept a body-supplied date to keep BFL audit clean.',
  ],
  example: {
    response: {
      data: { id: 'run_a8f1…', status: 'paid', paid_at: '2026-05-25T08:00:00Z' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(SalaryRunPaid) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.mark-paid',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Salary-run id must be a UUID.' },
      })
    }
    const salaryRunId = idParse.data

    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('salary_runs')
      .select('id, status')
      .eq('company_id', ctx.companyId!)
      .eq('id', salaryRunId)
      .maybeSingle()
    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!existing) {
      return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    if ((existing as { status: string }).status !== 'approved') {
      return v1ErrorResponseFromCode('SALARY_RUN_MARK_PAID_NOT_APPROVED', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: (existing as { status: string }).status },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          id: salaryRunId,
          would_advance_status_from: 'approved',
          would_advance_status_to: 'paid',
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data, error } = await ctx.supabase
      .from('salary_runs')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('company_id', ctx.companyId!)
      .eq('id', salaryRunId)
      .eq('status', 'approved')
      .select(MARK_PAID_COLUMNS)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      return v1ErrorResponseFromCode('SALARY_RUN_MARK_PAID_NOT_APPROVED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'race' },
      })
    }

    return ok(data, { requestId: ctx.requestId })
  },
)
