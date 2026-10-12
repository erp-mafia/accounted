import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateEmployeeSchema } from '@/lib/api/schemas'
import { maskEmployeeForResponse } from '@/lib/salary/personnummer'
import { createEmployee, sealPersonnummer } from '@/lib/salary/employee-commands'
import { employeeCommandErrorResponse } from '@/lib/salary/employee-command-response'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export const GET = withRouteContext('salary.employees.list', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const activeOnly = searchParams.get('active') !== 'false'

  let query = supabase
    .from('employees')
    .select('*')
    .eq('company_id', companyId)

  if (activeOnly) {
    query = query.eq('is_active', true)
  }

  const { data, error } = await query.order('last_name')

  if (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  // Mask personnummer: show birthdate, hide the 4-digit suffix. The shared
  // helper also strips personnummer_last4: mask + last4 in the same payload
  // would reassemble the full personnummer.
  const masked = (data || []).map((emp) => maskEmployeeForResponse(emp))

  return NextResponse.json({ data: masked })
})

export const POST = withRouteContext('salary.employees.create', async (request, { supabase, companyId, user }) => {
  const validation = await validateBody(request, CreateEmployeeSchema)
  if (!validation.success) return validation.response
  const { personnummer, ...fields } = validation.data

  // Format, date and check digit, then sealed: the service never sees the
  // plaintext. The rules (EF owner, bank details, jämkning) and the insert
  // are lib/salary/employee-commands.ts, shared with v1 and MCP.
  const sealed = sealPersonnummer(personnummer)
  if (!sealed.ok) return NextResponse.json({ error: sealed.message }, { status: 400 })

  const result = await createEmployee(supabase, {
    companyId: companyId!,
    userId: user.id,
    input: { ...fields, ...sealed.identity },
    columns: '*',
  })
  if (!result.ok) return employeeCommandErrorResponse(result)

  // The row is masked: the mask under `personnummer_masked` only, no
  // ciphertext and no personnummer_last4 (mask + last4 = the full number).
  return NextResponse.json({ data: result.data.row }, { status: 201 })
}, { requireWrite: true })
