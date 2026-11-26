import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateEmployeeBenefitSchema } from '@/lib/api/schemas'
import { createEmployeeBenefit, listEmployeeBenefits } from '@/lib/salary/employee-benefits'
import { failureResponse } from './failure-response'

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.benefits.list',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Active rows only: this is the register the panel lets the user add to
    // and remove from. A removed benefit that a payslip line derives from is
    // kept as is_active=false for provenance (#2695), and the engine (step
    // 8d) reads active rows only, so listing inactive rows here would show a
    // "removed" benefit as live. History stays reachable on v1 (?active=false)
    // and in the archive export.
    const result = await listEmployeeBenefits(supabase, { companyId, employeeId: id, active: true })
    if (!result.ok) return failureResponse(result)

    return NextResponse.json({ data: result.data })
  },
  { uuidParams: { id: 'EMPLOYEE_NOT_FOUND' } },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.benefits.create',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, CreateEmployeeBenefitSchema)
    if (!validation.success) return validation.response

    const result = await createEmployeeBenefit(supabase, {
      companyId,
      employeeId: id,
      userId: user.id,
      input: validation.data,
    })
    if (!result.ok) return failureResponse(result)

    // No dry-run on this door: the outcome is always the inserted row.
    const outcome = result.data
    return NextResponse.json(
      { data: outcome.committed ? outcome.row : outcome.preview },
      { status: 201 },
    )
  },
  { requireWrite: true, uuidParams: { id: 'EMPLOYEE_NOT_FOUND' } },
)
