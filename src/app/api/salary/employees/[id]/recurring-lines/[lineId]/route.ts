import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateEmployeeRecurringLineSchema } from '@/lib/api/schemas'
import { deleteEmployeeRecurringLine, updateEmployeeRecurringLine } from '@/lib/salary/employee-recurring-lines'
import { failureResponse } from '../failure-response'

export const PATCH = withRouteContext<{ params: Promise<{ id: string; lineId: string }> }>(
  'salary.employees.recurring_lines.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id, lineId } = await params

    const validation = await validateBody(request, UpdateEmployeeRecurringLineSchema)
    if (!validation.success) return validation.response

    const result = await updateEmployeeRecurringLine(supabase, {
      companyId,
      employeeId: id,
      lineId,
      patch: validation.data,
    })
    if (!result.ok) return failureResponse(result)

    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string; lineId: string }> }>(
  'salary.employees.recurring_lines.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id, lineId } = await params

    // Delete-first; a line a run has already derived from is deactivated
    // instead (the module documents the FK mechanics).
    const result = await deleteEmployeeRecurringLine(supabase, {
      companyId,
      employeeId: id,
      lineId,
    })
    if (!result.ok) return failureResponse(result)

    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)
