/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/approve
 *
 * Mirrors the dashboard's `/approve` route: validates every employee on the
 * run has the data the bookkeeping engine + payment will need (bank details
 * for transfer, calculation_breakdown proving :calculate ran), then advances
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
import { eventBus } from '@/lib/events'

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
    'Advances a salary run from `review` to `approved` after validating every employee has the data required for the payment step (bank account + clearing number for the bank transfer) and the booking step (`calculation_breakdown` proves `:calculate` ran). Records the approving user + timestamp. Strict-mode: validation errors return a complete list rather than failing on the first one.',
  useWhen:
    'You have a salary run in `review` status and want to authorize it for payment. This is the human (or agent) signoff step before money moves; the verifikation is still pending and won\'t exist until `:book` runs.',
  doNotUseFor:
    'Posting journal entries (use `:book` after `:mark-paid`). Reverting an approval (the lifecycle has no `:unapprove`: call `:correct` once the run is booked if you need to undo).',
  pitfalls: [
    'Run must be in `review`: non-`review` runs return 400 SALARY_RUN_APPROVE_NOT_REVIEW.',
    'Every employee on the run needs a `clearing_number` + `bank_account_number`. Missing bank details return 400 SALARY_RUN_APPROVE_VALIDATION_FAILED with the per-employee list.',
    'Every employee on the run needs `calculation_breakdown` populated. If you skipped `:calculate` somehow, approve fails.',
    'Employees without email get a non-blocking warning (lönebesked can\'t be sent automatically).',
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
    if ((existing as { status: string }).status !== 'review') {
      return v1ErrorResponseFromCode('SALARY_RUN_APPROVE_NOT_REVIEW', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: (existing as { status: string }).status },
      })
    }

    // Validation: pull every employee on the run with the fields we need
    // to assess. We accumulate ALL errors so the caller fixes everything
    // in one pass.
    const { data: runEmployees, error: empErr } = await ctx.supabase
      .from('salary_run_employees')
      .select(
        'calculation_breakdown, employee:employees(first_name, last_name, clearing_number, bank_account_number, email)',
      )
      .eq('salary_run_id', salaryRunId)
      // Defense-in-depth: every query carries the company_id filter per
      // CLAUDE.md, even when salary_run_id already constrains to the
      // company via FK + RLS.
      .eq('company_id', ctx.companyId!)
    if (empErr) {
      return v1ErrorResponse(empErr, ctx.log, { requestId: ctx.requestId })
    }

    const validationErrors: string[] = []
    const warnings: string[] = []
    // Supabase's generated types model nested FK joins as arrays even when
    // the FK is non-null one-to-one. Cast through `unknown` (matches the
    // pattern used by suppliers/customers in Phase 4) so the route stays
    // type-clean. The runtime shape is { employee: T | null } per the
    // single-FK join.
    for (const sre of ((runEmployees ?? []) as unknown) as Array<{
      calculation_breakdown: unknown
      employee: {
        first_name: string
        last_name: string
        clearing_number: string | null
        bank_account_number: string | null
        email: string | null
      } | null
    }>) {
      const emp = sre.employee
      if (!emp) continue
      const name = `${emp.first_name} ${emp.last_name}`
      if (!emp.clearing_number || !emp.bank_account_number) {
        validationErrors.push(
          `${name}: Bankuppgifter saknas (clearingnummer och/eller kontonummer)`,
        )
      }
      if (!sre.calculation_breakdown) {
        validationErrors.push(`${name}: Beräkning saknas, kör beräkning först`)
      }
      if (!emp.email) {
        warnings.push(`${name}: E-post saknas, lönebesked kan inte skickas`)
      }
    }
    if (validationErrors.length > 0) {
      return v1ErrorResponseFromCode('SALARY_RUN_APPROVE_VALIDATION_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: validationErrors, warnings },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          id: salaryRunId,
          would_advance_status_from: 'review',
          would_advance_status_to: 'approved',
          would_record_approver: ctx.userId,
          warnings,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Optimistic-lock the UPDATE on status='review' so a concurrent caller
    // (or a replay racing this one) yields a clean 409 instead of
    // silently re-approving and re-emitting the salary_run.approved event.
    const { data, error } = await ctx.supabase
      .from('salary_runs')
      .update({
        status: 'approved',
        approved_by: ctx.userId,
        approved_at: new Date().toISOString(),
      })
      .eq('company_id', ctx.companyId!)
      .eq('id', salaryRunId)
      .eq('status', 'review')
      .select(APPROVE_RESPONSE_COLUMNS)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      return v1ErrorResponseFromCode('SALARY_RUN_APPROVE_NOT_REVIEW', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'race' },
      })
    }

    try {
      await eventBus.emit({
        type: 'salary_run.approved',
        payload: {
          salaryRunId,
          approvedBy: ctx.userId,
          userId: ctx.userId,
          companyId: ctx.companyId!,
        },
      })
    } catch (err) {
      ctx.log.warn('salary_run.approved emit failed', err as Error)
    }

    return ok(
      { ...(data as Record<string, unknown>), warnings },
      { requestId: ctx.requestId },
    )
  },
)
