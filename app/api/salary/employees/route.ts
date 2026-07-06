import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateEmployeeSchema } from '@/lib/api/schemas'
import { requireCompanyId, getCompanyEntityType } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { decryptPersonnummer, encryptPersonnummer, extractLast4, maskPersonnummer, validatePersonnummer } from '@/lib/salary/personnummer'
import { isEmploymentTypeAllowedForEntity, EF_OWNER_EMPLOYMENT_ERROR } from '@/lib/salary/employment-rules'

ensureInitialized()

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

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
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Mask personnummer: show birthdate, hide the 4-digit suffix
  const masked = (data || []).map(emp => ({
    ...emp,
    personnummer: maskPersonnummer(decryptPersonnummer(emp.personnummer)),
  }))

  return NextResponse.json({ data: masked })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, CreateEmployeeSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  // Validate personnummer format + Luhn
  const pnrValidation = validatePersonnummer(body.personnummer)
  if (!pnrValidation.valid) {
    return NextResponse.json({ error: pnrValidation.error }, { status: 400 })
  }

  // An enskild firma owner cannot be put on payroll (they take egna uttag, not
  // lön). Block owner/board employment types for EF before inserting. The DB
  // trigger enforce_ef_no_owner_employee is the all-paths backstop; this gives
  // a clean 400 with guidance. #782
  const entityType = await getCompanyEntityType(supabase, companyId)
  if (!isEmploymentTypeAllowedForEntity(entityType, body.employment_type)) {
    return NextResponse.json({ error: EF_OWNER_EMPLOYMENT_ERROR }, { status: 400 })
  }

  // Encrypt personnummer
  const encryptedPnr = encryptPersonnummer(body.personnummer)
  const last4 = extractLast4(body.personnummer)

  const { data: employee, error } = await supabase
    .from('employees')
    .insert({
      company_id: companyId,
      user_id: user.id,
      first_name: body.first_name,
      last_name: body.last_name,
      personnummer: encryptedPnr,
      personnummer_last4: last4,
      employment_type: body.employment_type,
      employment_start: body.employment_start,
      employment_end: body.employment_end || null,
      employment_degree: body.employment_degree,
      salary_type: body.salary_type,
      monthly_salary: body.monthly_salary || null,
      hourly_rate: body.hourly_rate || null,
      tax_table_number: body.tax_table_number || null,
      tax_column: body.tax_column,
      tax_municipality: body.tax_municipality || null,
      is_sidoinkomst: body.is_sidoinkomst,
      f_skatt_status: body.f_skatt_status,
      clearing_number: body.clearing_number || null,
      bank_account_number: body.bank_account_number || null,
      vacation_rule: body.vacation_rule,
      vacation_days_per_year: body.vacation_days_per_year,
      semestertillagg_rate: body.semestertillagg_rate,
      email: body.email || null,
      phone: body.phone || null,
      address_line1: body.address_line1 || null,
      postal_code: body.postal_code || null,
      city: body.city || null,
      vaxa_stod_eligible: body.vaxa_stod_eligible,
      vaxa_stod_start: body.vaxa_stod_start || null,
      vaxa_stod_end: body.vaxa_stod_end || null,
      // Dimensions PR8: bag for the employee's P&L cost lines at booking.
      default_dimensions: body.default_dimensions ?? {},
    })
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
      ...employee,
      personnummer: maskPersonnummer(body.personnummer),
    },
  }, { status: 201 })
}
