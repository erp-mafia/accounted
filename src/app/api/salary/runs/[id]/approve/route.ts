import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { approveReviewedSalaryRun } from '@/lib/salary/approve-run'

/** review → approved (authorization recorded, with pre-approve validation).
 *  ?force=true bypasses the overridable "bank details missing or invalid" guard: approval
 *  is an authorization step, so the user may approve now and complete bank
 *  details before generating the payment file (which hard-blocks on its own).
 *  The rules and the step live in lib/salary/approve-run.ts, shared with the
 *  v1 :approve verb and the MCP book tool. */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.approve',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const force = new URL(request.url).searchParams.get('force') === 'true'

    const result = await approveReviewedSalaryRun(
      supabase,
      { companyId: companyId!, userId: user.id, salaryRunId: id, log },
      { force },
    )

    if (!result.ok) {
      if (result.dbError) return errorResponse(result.dbError, log, { requestId })
      const verdict = result.verdict
      // The run page reads these two bodies flat: details is the list it
      // shows, overridable decides whether it offers "Godkänn ändå".
      if (result.code === 'SALARY_APPROVE_BLOCKED' && verdict) {
        return NextResponse.json({
          error: 'Valideringsfel: korrigera innan godkännande',
          details: verdict.blocking,
          warnings: verdict.warnings,
          code: 'SALARY_APPROVE_BLOCKED',
          overridable: false,
        }, { status: 400 })
      }
      if (result.code === 'SALARY_APPROVE_BANK_DETAILS_MISSING' && verdict) {
        return NextResponse.json({
          error: 'Bankuppgifter saknas eller är ogiltiga för en eller flera anställda',
          details: verdict.bankDetails,
          warnings: verdict.warnings,
          code: 'SALARY_APPROVE_BANK_DETAILS_MISSING',
          overridable: true,
        }, { status: 400 })
      }
      return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    }

    return NextResponse.json({ data: result.data.run, warnings: result.data.warnings })
  },
  { requireWrite: true },
)
