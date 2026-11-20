import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateEmployeeBenefitSchema } from '@/lib/api/schemas'
import { deleteEmployeeBenefit, updateEmployeeBenefit } from '@/lib/salary/employee-benefits'
import { failureResponse } from '../failure-response'

export const PATCH = withRouteContext<{ params: Promise<{ id: string; benefitId: string }> }>(
  'salary.employees.benefits.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id, benefitId } = await params

    const validation = await validateBody(request, UpdateEmployeeBenefitSchema)
    if (!validation.success) return validation.response

    const result = await updateEmployeeBenefit(supabase, {
      companyId,
      employeeId: id,
      benefitId,
      patch: validation.data,
    })
    if (!result.ok) return failureResponse(result)

    // No dry-run on this door: the outcome is always the updated row.
    const outcome = result.data
    return NextResponse.json({ data: outcome.committed ? outcome.row : outcome.preview })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string; benefitId: string }> }>(
  'salary.employees.benefits.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id, benefitId } = await params

    const result = await deleteEmployeeBenefit(supabase, { companyId, employeeId: id, benefitId })
    if (!result.ok) return failureResponse(result)

    // No dry-run on this door: the outcome is always committed. A benefit
    // that a payslip line derives from is kept and switched off
    // (deleted=false, deactivated=true) so the line keeps its provenance and
    // the next recalculation of a draft run drops it (#2695); the panel
    // tells the user to recalculate. Neither flag set means no row matched.
    const outcome = result.data
    const deleted = outcome.committed && outcome.deleted
    const deactivated = outcome.committed && outcome.deactivated === true
    if (!deleted && !deactivated) {
      return NextResponse.json({ error: 'Förmån hittades inte' }, { status: 404 })
    }
    return NextResponse.json({ data: { id: benefitId, deleted, deactivated } })
  },
  { requireWrite: true },
)
