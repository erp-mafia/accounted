import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateEmployeeRecurringLineSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.recurring_lines.list',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data, error } = await supabase
      .from('employee_recurring_lines')
      .select('*')
      .eq('employee_id', id)
      .eq('company_id', companyId)
      .order('valid_from', { ascending: false })

    if (error) return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })

    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.recurring_lines.create',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, CreateEmployeeRecurringLineSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Confirm employee belongs to the company
    const { data: emp } = await supabase
      .from('employees')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()
    if (!emp) return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })

    const { data, error } = await supabase
      .from('employee_recurring_lines')
      .insert({
        employee_id: id,
        company_id: companyId,
        user_id: user.id,
        item_type: body.item_type,
        description: body.description,
        amount: body.amount,
        account_number: body.account_number ?? null,
        valid_from: body.valid_from,
        valid_to: body.valid_to ?? null,
        metadata: body.metadata ?? {},
        is_active: body.is_active ?? true,
      })
      .select()
      .single()

    if (error) {
      // The create schema mirrors every CHECK on the table (item_type
      // whitelist, amount sign, account format, valid_to >= valid_from), so a
      // check_violation here is only the backstop for non-schema callers: bad
      // input, not a server fault.
      const status = error.code === '23514' ? 400 : 500
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status })
    }

    return NextResponse.json({ data }, { status: 201 })
  },
  { requireWrite: true },
)
