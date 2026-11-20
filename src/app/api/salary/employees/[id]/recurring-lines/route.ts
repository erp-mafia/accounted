import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateEmployeeRecurringLineSchema } from '@/lib/api/schemas'
import { createEmployeeRecurringLine, listEmployeeRecurringLines } from '@/lib/salary/employee-recurring-lines'
import { failureResponse } from './failure-response'

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.recurring_lines.list',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const result = await listEmployeeRecurringLines(supabase, { companyId, employeeId: id })
    if (!result.ok) return failureResponse(result)

    return NextResponse.json({ data: result.data })
  },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.recurring_lines.create',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, CreateEmployeeRecurringLineSchema)
    if (!validation.success) return validation.response

    const result = await createEmployeeRecurringLine(supabase, {
      companyId,
      employeeId: id,
      userId: user.id,
      input: validation.data,
    })
    if (!result.ok) return failureResponse(result)

    return NextResponse.json({ data: result.data }, { status: 201 })
  },
  { requireWrite: true },
)
