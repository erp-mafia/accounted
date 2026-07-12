import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateSalaryLineItemSchema } from '@/lib/api/schemas'
import { getLineItemAccount } from '@/lib/salary/account-mapping'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.line.create',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const validation = await validateBody(request, CreateSalaryLineItemSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Verify run is draft
    const { data: run } = await supabase
      .from('salary_runs')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!run) {
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    }
    if (run.status !== 'draft') {
      return NextResponse.json({ error: 'Kan bara redigera utkast' }, { status: 400 })
    }

    // Verify salary_run_employee belongs to this run
    const { data: sre } = await supabase
      .from('salary_run_employees')
      .select('id, employee_id')
      .eq('id', body.salary_run_employee_id)
      .eq('salary_run_id', id)
      .single()

    if (!sre) {
      return NextResponse.json({ error: 'Anställd finns inte i denna lönekörning' }, { status: 404 })
    }

    // Auto-resolve account if not provided
    const accountNumber = body.account_number || getLineItemAccount(body.item_type as never)

    const { data: lineItem, error } = await supabase
      .from('salary_line_items')
      .insert({
        salary_run_employee_id: body.salary_run_employee_id,
        company_id: companyId,
        item_type: body.item_type,
        description: body.description,
        quantity: body.quantity || null,
        unit_price: body.unit_price || null,
        amount: Math.round(body.amount * 100) / 100,
        is_taxable: body.is_taxable,
        is_avgift_basis: body.is_avgift_basis,
        is_vacation_basis: body.is_vacation_basis,
        is_gross_deduction: body.is_gross_deduction,
        is_net_deduction: body.is_net_deduction,
        account_number: accountNumber,
        sort_order: body.sort_order,
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data: lineItem }, { status: 201 })
  },
  { requireWrite: true },
)
