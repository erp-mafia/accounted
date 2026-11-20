import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sparsePatchBody } from '@/lib/api/sparse-patch'
import { UpdateSalaryLineItemSchema } from '@/lib/api/schemas'
import { updatePayslipLine, deletePayslipLine } from '@/lib/salary/payslip-lines'
import { getErrorEntry } from '@/lib/errors/structured-errors'

function errorResponse(code: string, details?: Record<string, unknown>): NextResponse {
  const entry = getErrorEntry(code)
  // A line rule names its own Swedish reason (details.message); the
  // registry text alone only says the request was invalid.
  const reason = typeof details?.message === 'string' ? details.message : null
  return NextResponse.json(
    { error: reason ?? entry?.message_sv ?? 'Något gick fel', code },
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
    // sort_order=0, which updatePayslipLine spreads straight into .update().
    // Correcting an amount would silently move the line to the top.
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

    if (!result.ok) return errorResponse(result.code, result.details)
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
