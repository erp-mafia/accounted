import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
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

    const validation = await validateBody(request, UpdateSalaryLineItemSchema)
    if (!validation.success) return validation.response

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
