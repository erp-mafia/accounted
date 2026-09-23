import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sparsePatchBody } from '@/lib/api/sparse-patch'
import { UpdateSalaryLineItemSchema } from '@/lib/api/schemas'
import { updatePayslipLine, deletePayslipLine } from '@/lib/salary/payslip-lines'
import { getErrorEntry } from '@/lib/errors/structured-errors'

ensureInitialized()

function errorResponse(code: string): NextResponse {
  const entry = getErrorEntry(code)
  return NextResponse.json(
    { error: entry?.message_sv ?? 'Något gick fel', code },
    { status: entry?.httpStatus ?? 500 },
  )
}

export const PATCH = withRouteContext<{ params: Promise<{ id: string; lineId: string }> }>(
  'salary.run.line.update',
  async (request, ctx, { params }) => {
    const { id, lineId } = await params
    const { supabase, companyId } = ctx

    // sparsePatchBody, not the bare schema: UpdateSalaryLineItemSchema is
    // CreateSalaryLineItemSchema.partial(), and .partial() does NOT strip
    // .default(). Parsed bare, `{ amount: 5500 }` comes back carrying
    // is_taxable/is_avgift_basis/is_vacation_basis=true,
    // is_gross_deduction/is_net_deduction=false, sort_order=0, all of which
    // updatePayslipLine spreads straight into .update(). Correcting the amount
    // on a net deduction line would silently turn it into a taxable earning.
    const validation = await validateBody(request, sparsePatchBody(UpdateSalaryLineItemSchema))
    if (!validation.success) return validation.response

    if (Object.keys(validation.data).length === 0) {
      return NextResponse.json({ error: 'Inget att uppdatera' }, { status: 400 })
    }

    const result = await updatePayslipLine(supabase, {
      companyId,
      salaryRunId: id,
      lineId,
      patch: validation.data,
    })

    if (!result.ok) return errorResponse(result.code)
    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string; lineId: string }> }>(
  'salary.run.line.delete',
  async (_request, ctx, { params }) => {
    const { id, lineId } = await params
    const { supabase, companyId } = ctx

    const result = await deletePayslipLine(supabase, {
      companyId,
      salaryRunId: id,
      lineId,
    })

    if (!result.ok) return errorResponse(result.code)
    return NextResponse.json({ data: { deleted: true } })
  },
  { requireWrite: true },
)
