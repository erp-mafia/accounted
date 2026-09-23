import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { runSalaryCalculation } from '@/lib/salary/run-calculation'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * POST /api/salary/runs/{id}/calculate
 *
 * Thin wrapper over `runSalaryCalculation()` from `lib/salary/run-calculation.ts`.
 * The orchestration was extracted in Phase 5 PR-2 so the v1 public route
 * (`POST /api/v1/companies/{companyId}/salary-runs/{id}/calculate`) can call
 * the same code. This route's responsibility is now: auth → invoke helper →
 * convert the discriminated result into the dashboard's expected envelope
 * (`{ data, warnings? }` on success; structured-error envelope on failure).
 *
 * Status transitions stay where they were: this route does NOT advance
 * `salary_runs.status`. The dashboard's UX is calculate → review (explicit
 * `/review` verb) → approve. The v1 collapses calculate+review into a
 * single verb but applies the status flip at the route layer, not here.
 */
export const POST = withRouteContext(
  'salary_run.calculate',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const result = await runSalaryCalculation({
      supabase,
      companyId: companyId!,
      salaryRunId: id,
      log,
      requestId,
    })

    if (!result.ok) {
      return errorResponseFromCode(result.code, log, {
        requestId,
        details: result.details,
        status: result.status,
      })
    }

    return NextResponse.json({ data: result.run, warnings: result.warnings })
  },
  { requireWrite: true },
)
