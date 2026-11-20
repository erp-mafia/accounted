/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/approve
 *
 * The dashboard's `/approve` step through the same service
 * (lib/salary/approve-run.ts): validates every employee on the run has the
 * data the booking and payment need (calculation_breakdown proving
 * :calculate ran, bank details for an employee with a payout), then advances
 * status `review` → `approved` with an optimistic-lock UPDATE. Records the
 * approver in `approved_by` + `approved_at`. Emits `salary_run.approved`.
 *
 * No engine interaction. No period-lock check. The verifikation gets posted
 * later by `:book`.
 *
 * Strict-mode: validation errors return 400 with a structured list of every
 * problem found across every employee, not just the first. An agent fixing
 * issues in batch sees a complete picture rather than playing whack-a-mole.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { approveReviewedSalaryRun } from '@/lib/salary/approve-run'

const SalaryRunApproved = z.object({
  id: z.string().uuid(),
  status: z.literal('approved'),
  approved_at: z.string(),
  approved_by: z.string().uuid().nullable(),
  warnings: z.array(z.string()),
})

const APPROVE_RESPONSE_COLUMNS = 'id, status, approved_at, approved_by'

registerEndpoint({
  operation: 'salary-runs.approve',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs/:id/approve',
  summary: 'Approve a reviewed salary run.',
  description:
    'Advances a salary run from `review` to `approved` after validating every employee has the data required for the payment step (bank account + clearing number for an employee with a payout) and the booking step (`calculation_breakdown` proves `:calculate` ran). Records the approving user + timestamp. Strict-mode: validation errors return a complete list rather than failing on the first one.',
  useWhen:
    'You have a salary run in `review` status and want to authorize it for payment. This is the human (or agent) signoff step before money moves; the verifikation is still pending and won\'t exist until `:book` runs.',
  doNotUseFor:
    'Posting journal entries (use `:book` after `:mark-paid`). Reverting an approval (POST /salary-runs/{id}/unapprove while the run is unpaid and its AGI unfiled; call `:correct` once the run is booked).',
  pitfalls: [
    'Run must be in `review`: non-`review` runs return 400 SALARY_RUN_APPROVE_NOT_REVIEW.',
    'Every employee with a payout (net after any tax override > 0) needs a `clearing_number` + `bank_account_number` that name a payable account (clearing 4 digits, or 5 starting with 8; account 5-10 digits without the clearing number). Missing or invalid bank details return 400 SALARY_RUN_APPROVE_VALIDATION_FAILED with the per-employee list; the list names employees, never account numbers. An employee with nothing to pay out (nollkörning, or a net fully used by a nettolöneavdrag) needs none: the payment file has no line for them.',
    'Every employee on the run needs `calculation_breakdown` populated. If you skipped `:calculate` somehow, approve fails.',
    'Employees without email get a non-blocking warning (lönebesked can\'t be sent automatically), and so does an employee whose F-skatt is not verified (30% skatteavdrag and full avgifter apply).',
    'No period-lock check here: that lives on `:book` where the verifikation is posted. An agent can approve a run whose payment date falls in a now-locked period; `:book` will later refuse.',
  ],
  example: {
    response: {
      data: {
        id: 'run_a8f1…',
        status: 'approved',
        approved_at: '2026-05-14T12:00:00Z',
        approved_by: 'user_b73c…',
        warnings: ['Anna Andersson: E-post saknas, lönebesked kan inte skickas'],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(SalaryRunApproved) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.approve',
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

    // The rules and the step are lib/salary/approve-run.ts, shared with the
    // dashboard and the MCP book tool. v1 has no override: bank details for
    // an employee with a payout are a validation failure here.
    const result = await approveReviewedSalaryRun(
      ctx.supabase,
      { companyId: ctx.companyId!, userId: ctx.userId, salaryRunId, log: ctx.log },
      { dryRun: ctx.dryRun, columns: APPROVE_RESPONSE_COLUMNS },
    )

    if (!result.ok) {
      if (result.dbError) return v1ErrorResponse(result.dbError, ctx.log, { requestId: ctx.requestId })
      // Every problem across every employee, so the caller fixes them in
      // one pass.
      if (result.verdict) {
        return v1ErrorResponseFromCode('SALARY_RUN_APPROVE_VALIDATION_FAILED', ctx.log, {
          requestId: ctx.requestId,
          details: {
            issues: [...result.verdict.blocking, ...result.verdict.bankDetails],
            warnings: result.verdict.warnings,
          },
        })
      }
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          id: salaryRunId,
          would_advance_status_from: 'review',
          would_advance_status_to: 'approved',
          would_record_approver: ctx.userId,
          warnings: result.data.warnings,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    return ok(
      { ...(result.data.run as Record<string, unknown>), warnings: result.data.warnings },
      { requestId: ctx.requestId },
    )
  },
)
