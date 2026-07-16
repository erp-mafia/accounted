import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { OpeningBalancesFieldsSchema } from '@/lib/api/schemas'
import { getOpeningBalances, setOpeningBalancesBulk } from '@/lib/salary/opening-balances'
import { getErrorEntry } from '@/lib/errors/structured-errors'

ensureInitialized()

function errorResponse(code: string, message?: string): NextResponse {
  const entry = getErrorEntry(code)
  return NextResponse.json(
    { error: message ?? entry?.message_sv ?? 'Något gick fel', code },
    { status: entry?.httpStatus ?? 500 },
  )
}

/** Cutover opening balances for one employee (dashboard surface; the v1
 * routes and the MCP tool share the same lib/salary/opening-balances
 * service). Returns { data: null } when nothing is set: the form treats
 * that as an empty editable state, unlike v1's 404. */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.opening-balances.get',
  async (_request, { supabase, companyId }, { params }) => {
    const { id: employeeId } = await params

    const result = await getOpeningBalances(supabase, { companyId, employeeId })
    if (!result.ok) return errorResponse(result.code)
    return NextResponse.json({ data: result.data })
  },
)

export const PUT = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.opening-balances.set',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id: employeeId } = await params

    const validation = await validateBody(request, OpeningBalancesFieldsSchema)
    if (!validation.success) return validation.response

    const result = await setOpeningBalancesBulk(supabase, {
      companyId,
      userId: user.id,
      items: [{ employee_id: employeeId, ...validation.data }],
    })

    if (!result.ok) {
      const itemError = result.itemErrors?.[0]
      return errorResponse(itemError?.code ?? result.code, itemError?.message)
    }

    return NextResponse.json({ data: result.data.rows[0] })
  },
  { requireWrite: true },
)
