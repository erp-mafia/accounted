import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateEmployeeSchema } from '@/lib/api/schemas'
import { getCompanyEntityType } from '@/lib/company/context'
import { decryptPersonnummer, encryptPersonnummer, extractLast4, maskPersonnummer, validatePersonnummer } from '@/lib/salary/personnummer'
import { isEmploymentTypeAllowedForEntity, EF_OWNER_EMPLOYMENT_ERROR } from '@/lib/salary/employment-rules'
import { validateEmployeeBankAccount } from '@/lib/salary/payment/bank-account'

ensureInitialized()

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.get',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data: employee, error } = await supabase
      .from('employees')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !employee) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    return NextResponse.json({
      data: {
        ...employee,
        personnummer: maskPersonnummer(decryptPersonnummer(employee.personnummer)),
      },
    })
  },
)

export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, UpdateEmployeeSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Load existing employee for merged validation
    const { data: existing, error: fetchError } = await supabase
      .from('employees')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !existing) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    // Merged validation: combine existing + updates to check full integrity
    const merged = { ...existing, ...body }
    const mergedErrors: string[] = []

    if (merged.salary_type === 'monthly' && (!merged.monthly_salary || merged.monthly_salary <= 0)) {
      mergedErrors.push('Månadslön krävs och måste vara större än 0 för månadslöneform')
    }
    if (merged.salary_type === 'hourly' && (!merged.hourly_rate || merged.hourly_rate <= 0)) {
      mergedErrors.push('Timlön krävs och måste vara större än 0 för timlöneform')
    }
    if (merged.f_skatt_status === 'a_skatt' && !merged.is_sidoinkomst && !merged.tax_table_number) {
      mergedErrors.push('Skattetabell krävs för A-skatt anställda')
    }
    if (mergedErrors.length > 0) {
      return NextResponse.json({ error: mergedErrors.join('. ') }, { status: 400 })
    }

    // Validate bank details only when the caller actually changes them, so a
    // legacy employee with incomplete/free-text bank data (from before this
    // validation existed) can still be edited in unrelated ways. Validate the
    // merged pair so both-or-neither reflects the row's real end state.
    const clearingChanged =
      body.clearing_number !== undefined && body.clearing_number !== existing.clearing_number
    const accountChanged =
      body.bank_account_number !== undefined && body.bank_account_number !== existing.bank_account_number
    if (clearingChanged || accountChanged) {
      const bankIssues = validateEmployeeBankAccount(merged.clearing_number, merged.bank_account_number)
      if (bankIssues.length > 0) {
        return NextResponse.json({ error: bankIssues.map((i) => i.message).join('. ') }, { status: 400 })
      }
    }

    // Only when the caller is changing employment_type: block setting an EF's
    // owner/board on payroll (mirrors the enforce_ef_no_owner_employee trigger,
    // which fires on UPDATE OF employment_type: so unrelated edits to any
    // grandfathered row aren't blocked). #782
    if (body.employment_type !== undefined) {
      const entityType = await getCompanyEntityType(supabase, companyId)
      if (!isEmploymentTypeAllowedForEntity(entityType, body.employment_type)) {
        return NextResponse.json({ error: EF_OWNER_EMPLOYMENT_ERROR }, { status: 400 })
      }
    }

    // Build update object
    const updates: Record<string, unknown> = { ...body }

    // Handle personnummer update if provided
    if (body.personnummer) {
      const pnrValidation = validatePersonnummer(body.personnummer)
      if (!pnrValidation.valid) {
        return NextResponse.json({ error: pnrValidation.error }, { status: 400 })
      }
      updates.personnummer = encryptPersonnummer(body.personnummer)
      updates.personnummer_last4 = extractLast4(body.personnummer)
    }

    const { data: updated, error } = await supabase
      .from('employees')
      .update(updates)
      .eq('id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'En anställd med detta personnummer finns redan' }, { status: 409 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      data: {
        ...updated,
        personnummer: maskPersonnummer(decryptPersonnummer(updated.personnummer)),
      },
    })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.delete',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Soft delete only, BFL 7 kap retention
    const { data, error } = await supabase
      .from('employees')
      .update({ is_active: false })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id')
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    return NextResponse.json({ data: { id: data.id, is_active: false } })
  },
  { requireWrite: true },
)
