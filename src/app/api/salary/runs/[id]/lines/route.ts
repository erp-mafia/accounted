import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateSalaryLineItemSchema } from '@/lib/api/schemas'
import { createPayslipLine } from '@/lib/salary/payslip-lines'
import { getErrorEntry } from '@/lib/errors/structured-errors'

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.line.create',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const validation = await validateBody(request, CreateSalaryLineItemSchema)
    if (!validation.success) return validation.response
    const { salary_run_employee_id, ...input } = validation.data

    const result = await createPayslipLine(supabase, {
      companyId,
      salaryRunId: id,
      target: { salaryRunEmployeeId: salary_run_employee_id },
      input,
    })

    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      // A line rule names its own Swedish reason (details.message); the
      // registry text alone only says the request was invalid.
      const reason = typeof result.details?.message === 'string' ? result.details.message : null
      return NextResponse.json(
        { error: reason ?? entry?.message_sv ?? 'Något gick fel', code: result.code },
        { status: entry?.httpStatus ?? 500 },
      )
    }

    return NextResponse.json({ data: result.data }, { status: 201 })
  },
  { requireWrite: true },
)
