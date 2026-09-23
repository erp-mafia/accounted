import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { AddEmployeeToRunSchema } from '@/lib/api/schemas'
import { addEmployeeToRun } from '@/lib/salary/run-employees'
import { getErrorEntry } from '@/lib/errors/structured-errors'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.employee.add',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const validation = await validateBody(request, AddEmployeeToRunSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const result = await addEmployeeToRun(supabase, {
      companyId,
      salaryRunId: id,
      employeeId: body.employee_id,
      hoursWorked: body.hours_worked ?? null,
    })

    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      return NextResponse.json(
        { error: entry?.message_sv ?? 'Något gick fel', code: result.code },
        { status: entry?.httpStatus ?? 500 },
      )
    }

    return NextResponse.json({ data: result.data }, { status: 201 })
  },
  { requireWrite: true },
)
