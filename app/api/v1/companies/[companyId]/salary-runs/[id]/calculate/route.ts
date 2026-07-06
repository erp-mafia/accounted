/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/calculate
 *
 * v1's :calculate collapses the dashboard's two-step flow (internal /calculate
 * does the math but leaves status='draft'; internal /review explicitly
 * advances draft→review) into a single agent-friendly verb:
 *
 *   1. Invoke `runSalaryCalculation()` (the shared lib helper that the
 *      dashboard's /calculate also uses).
 *   2. On success, optimistic-lock UPDATE draft → review with an explicit
 *      `.eq('status', 'draft')` guard so concurrent calls yield a clean
 *      409, not a silent overwrite.
 *   3. Surface F-skatt 'not_verified' warnings (carried over from the
 *      dashboard's /review F-skatt gate) alongside the calculation
 *      warnings (tax table fallback, läkarintyg, FK day-15).
 *
 * Strict-mode: if any step inside `runSalaryCalculation` fails, the helper
 * returns a structured `{ ok: false }` and this route surfaces that without
 * touching status. The run stays in `draft` and the agent can retry.
 *
 * No engine interaction. No period-lock check (that lives on :book where
 * the JEs are actually posted).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { runSalaryCalculation } from '@/lib/salary/run-calculation'

const SalaryRunCalculated = z.object({
  id: z.string().uuid(),
  status: z.literal('review'),
  period_year: z.number().int(),
  period_month: z.number().int(),
  total_gross: z.number(),
  total_tax: z.number(),
  total_net: z.number(),
  total_avgifter: z.number(),
  total_employer_cost: z.number(),
  warnings: z.array(z.string()),
})

registerEndpoint({
  operation: 'salary-runs.calculate',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs/:id/calculate',
  summary: 'Calculate a draft salary run and advance it to review.',
  description:
    'Runs the per-employee payroll calculation (tax withholding, employer contributions, vacation accrual) for every employee on a draft run, persists the line items + run totals + calculation_params snapshot, then promotes status from draft to review in a single atomic verb. Returns the updated run plus a `warnings` array surfacing non-blocking issues (Skatteverket tax-table fallback, läkarintyg day-8 transition, Försäkringskassan day-15 transition, F-skatt not-verified employees). Strict-mode: any failure (validation, tax-table unavailable, DB error) aborts before the status flip: the run stays in draft.',
  useWhen:
    'You have a draft salary run with employees added and want to compute the numbers + freeze them for approval. This is the first lifecycle verb after creating a run.',
  doNotUseFor:
    're-running a salary run already in review or later (only `draft` is accepted: call POST :correct in Phase 5 PR-3 once that ships to revise a booked run). Adding employees to the run (that surface is not yet on v1; use the dashboard).',
  pitfalls: [
    'Run must be in `draft` status: calculate on a non-draft run returns 400 SALARY_RUN_CALCULATE_NOT_DRAFT.',
    'Salary run must have at least one employee: empty runs return 400 SALARY_RUN_NO_EMPLOYEES.',
    'If Skatteverket\'s tax-table API is down and local fallback is missing the required table, calculate returns 503 SALARY_RUN_TAX_TABLE_MISSING. Retry is safe; the operation is idempotent at the helper level.',
    'F-skatt "not_verified" employees produce a non-blocking warning; an integrator should treat the warning as a hard signal that withholding will be wrong until F-skatt is verified.',
    'Warnings about tax-table fallback or läkarintyg / FK day-15 transitions are non-blocking; the run still advances to review. Surface them to a human reviewer before calling :approve.',
  ],
  example: {
    response: {
      data: {
        id: 'run_a8f1…',
        status: 'review',
        period_year: 2026,
        period_month: 5,
        total_gross: 105000,
        total_tax: 28500,
        total_net: 76500,
        total_avgifter: 32991,
        total_employer_cost: 137991,
        warnings: [
          'Läkarintyg krävs från och med dag 8: Anna Andersson. Kontrollera att läkarintyg finns innan lönekörningen godkänns.',
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(SalaryRunCalculated) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.calculate',
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

    // Pre-flight status check so a dry-run can preview the would-be outcome
    // without committing any of the calculation's many side effects.
    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('salary_runs')
      .select('id, status, period_year, period_month, payment_date')
      .eq('company_id', ctx.companyId!)
      .eq('id', salaryRunId)
      .maybeSingle()
    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!existing) {
      return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    if ((existing as { status: string }).status !== 'draft') {
      return v1ErrorResponseFromCode('SALARY_RUN_CALCULATE_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: (existing as { status: string }).status },
      })
    }

    if (ctx.dryRun) {
      // The helper is a heavy operation with hundreds of DB writes: we
      // cannot meaningfully "dry-run" it without committing real state.
      // Instead the dry-run surfaces what WOULD happen at the contract
      // level: status flip + a hint that the math will run. Agents can
      // use this to validate the preconditions before paying for the
      // expensive call.
      return dryRunPreview(
        {
          id: salaryRunId,
          would_advance_status_from: 'draft',
          would_advance_status_to: 'review',
          note: 'A live call will compute per-employee tax, avgifter, and vacation accrual, then persist line items + run totals. The actual figures are only available on a real (non-dry-run) call.',
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const result = await runSalaryCalculation({
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      salaryRunId,
      log: ctx.log,
      requestId: ctx.requestId,
    })

    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
        status: result.status,
      })
    }

    // Advance status draft → review with an optimistic-lock guard. A
    // concurrent call (or replay) that beat us to it would have seen the
    // helper's status-check fail, but defense-in-depth here covers the
    // window between the helper's UPDATE on totals and our status flip.
    //
    // Also surface F-skatt 'not_verified' employees as additional warnings,
    // mirroring the dashboard's internal /review step.
    const { data: runEmployees } = await ctx.supabase
      .from('salary_run_employees')
      .select('employee:employees(first_name, last_name, f_skatt_status)')
      .eq('salary_run_id', salaryRunId)

    const fskattWarnings: string[] = []
    // See approve/route.ts: Supabase types nested FK joins as arrays even
    // for single-FK relations; cast through `unknown` so the route stays
    // type-clean.
    for (const sre of ((runEmployees ?? []) as unknown) as Array<{
      employee: { first_name: string; last_name: string; f_skatt_status: string } | null
    }>) {
      const emp = sre.employee
      if (emp?.f_skatt_status === 'not_verified') {
        fskattWarnings.push(
          `${emp.first_name} ${emp.last_name}: F-skatt ej verifierad: 30% skatteavdrag och fulla avgifter tillämpas (f-skatt.md)`,
        )
      }
    }

    const { data: advancedRun, error: advanceErr } = await ctx.supabase
      .from('salary_runs')
      .update({ status: 'review' })
      .eq('company_id', ctx.companyId!)
      .eq('id', salaryRunId)
      .eq('status', 'draft')
      .select('id, status, period_year, period_month, total_gross, total_tax, total_net, total_avgifter, total_employer_cost')
      .maybeSingle()

    if (advanceErr) {
      return v1ErrorResponse(advanceErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!advancedRun) {
      // Race: status transitioned between the helper completing and the
      // status UPDATE. The most likely cause is a concurrent v1 call also
      // doing :calculate; both will have re-run the math, the second one
      // gets the stale-status 409.
      return v1ErrorResponseFromCode('SALARY_RUN_CALCULATE_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'race' },
      })
    }

    return ok(
      {
        ...(advancedRun as Record<string, unknown>),
        warnings: [...result.warnings, ...fskattWarnings],
      },
      { requestId: ctx.requestId },
    )
  },
)
