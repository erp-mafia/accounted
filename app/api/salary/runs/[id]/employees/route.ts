import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { AddEmployeeToRunSchema } from '@/lib/api/schemas'
import { getLineItemAccount } from '@/lib/salary/account-mapping'
import type { SalaryLineItemType } from '@/types'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.employee.add',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const validation = await validateBody(request, AddEmployeeToRunSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Verify run is draft
    const { data: run, error: runError } = await supabase
      .from('salary_runs')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (runError || !run) {
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    }
    if (run.status !== 'draft') {
      return NextResponse.json({ error: 'Kan bara lägga till anställda i utkast' }, { status: 400 })
    }

    // Verify employee exists and is active
    const { data: employee, error: empError } = await supabase
      .from('employees')
      .select('*')
      .eq('id', body.employee_id)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .single()

    if (empError || !employee) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    // Check if already added
    const { data: existing } = await supabase
      .from('salary_run_employees')
      .select('id')
      .eq('salary_run_id', id)
      .eq('employee_id', body.employee_id)
      .single()

    if (existing) {
      return NextResponse.json({ error: 'Anställd redan tillagd i denna lönekörning' }, { status: 409 })
    }

    // Snapshot employee data
    const { data: sre, error: sreError } = await supabase
      .from('salary_run_employees')
      .insert({
        salary_run_id: id,
        employee_id: employee.id,
        company_id: companyId,
        employment_degree: employee.employment_degree,
        monthly_salary: employee.monthly_salary || 0,
        salary_type: employee.salary_type,
        hours_worked: body.hours_worked || null,
        tax_table_number: employee.tax_table_number,
        tax_column: employee.tax_column,
      })
      .select()
      .single()

    if (sreError) {
      return NextResponse.json({ error: sreError.message }, { status: 500 })
    }

    // Auto-create base salary line item
    const baseSalaryType: SalaryLineItemType = employee.salary_type === 'monthly' ? 'monthly_salary' : 'hourly_salary'
    let baseAmount: number
    if (employee.salary_type === 'monthly') {
      baseAmount = Math.round((employee.monthly_salary || 0) * (employee.employment_degree / 100) * 100) / 100
    } else {
      baseAmount = Math.round((employee.hourly_rate || 0) * (body.hours_worked || 0) * 100) / 100
    }

    await supabase
      .from('salary_line_items')
      .insert({
        salary_run_employee_id: sre.id,
        company_id: companyId,
        item_type: baseSalaryType,
        description: employee.salary_type === 'monthly' ? 'Grundlön' : 'Timlön',
        quantity: employee.salary_type === 'hourly' ? body.hours_worked : null,
        unit_price: employee.salary_type === 'hourly' ? employee.hourly_rate : null,
        amount: baseAmount,
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
        account_number: getLineItemAccount(baseSalaryType, employee.employment_type),
        sort_order: 0,
      })

    return NextResponse.json({ data: sre }, { status: 201 })
  },
  { requireWrite: true },
)
