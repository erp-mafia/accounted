import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { generateKU10Xml } from '@/lib/salary/ku/ku10-generator'
import type { KU10EmployeeData, KU10CompanyData } from '@/lib/salary/ku/ku10-generator'

ensureInitialized()

/**
 * Generate KU10 (Kontrolluppgift) XML for a calendar year.
 *
 * Per Skatteförfarandelagen 15 kap: Must be filed by January 31 of the
 * following year. Reports total annual income, tax, and benefits per employee.
 *
 * The XML is räkenskapsinformation per BFL 7 kap, 7-year retention.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ year: string }> }
) {
  const { year } = await params
  const yearNum = parseInt(year)
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  if (isNaN(yearNum) || yearNum < 2020 || yearNum > 2100) {
    return NextResponse.json({ error: 'Ogiltigt år' }, { status: 400 })
  }

  // Load company
  const { data: company } = await supabase
    .from('companies')
    .select('name, org_number')
    .eq('id', companyId)
    .single()

  if (!company) return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })

  const { data: settings } = await supabase
    .from('company_settings')
    .select('org_number, phone, email')
    .eq('company_id', companyId)
    .single()

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', user.id)
    .single()

  // Load all booked salary run employees for the year, grouped by employee
  const { data: runEmployees, error } = await supabase
    .from('salary_run_employees')
    .select(`
      employee_id, gross_salary, tax_withheld, tax_withheld_override,
      avgifter_basis, avgifter_basis_override,
      employee:employees(personnummer, specification_number, employment_start, employment_end),
      salary_run:salary_runs!inner(period_year, status),
      line_items:salary_line_items(item_type, amount)
    `)
    .eq('company_id', companyId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Filter to booked runs for the year
  const bookedForYear = (runEmployees || []).filter(sre => {
    const run = sre.salary_run as unknown as { period_year: number; status: string } | null
    return run && run.period_year === yearNum && run.status === 'booked'
  })

  // Aggregate per employee
  const byEmployee = new Map<string, {
    personnummer: string
    specificationNumber: number
    employmentStart: string | null
    employmentEnd: string | null
    totalGross: number
    totalTax: number
    totalAvgifterBasis: number
    benefitCar: number
    benefitHousing: number
    benefitMeals: number
    benefitOther: number
  }>()

  for (const sre of bookedForYear) {
    const emp = sre.employee as unknown as { personnummer: string; specification_number: number; employment_start: string; employment_end: string | null } | null
    if (!emp) continue

    const current = byEmployee.get(sre.employee_id) || {
      personnummer: emp.personnummer,
      specificationNumber: emp.specification_number,
      employmentStart: emp.employment_start,
      employmentEnd: emp.employment_end,
      totalGross: 0, totalTax: 0, totalAvgifterBasis: 0,
      benefitCar: 0, benefitHousing: 0, benefitMeals: 0, benefitOther: 0,
    }

    current.totalGross += sre.gross_salary
    // Honor advanced-mode override so KU matches AGI + the ledger.
    current.totalTax += sre.tax_withheld_override ?? sre.tax_withheld
    current.totalAvgifterBasis += sre.avgifter_basis_override ?? sre.avgifter_basis

    // Sum benefits by type from line items
    const lineItems = (sre.line_items || []) as Array<{ item_type: string; amount: number }>
    for (const li of lineItems) {
      if (li.item_type === 'benefit_car') current.benefitCar += li.amount
      else if (li.item_type === 'benefit_housing') current.benefitHousing += li.amount
      else if (li.item_type === 'benefit_meals') current.benefitMeals += li.amount
      else if (['benefit_wellness', 'benefit_other'].includes(li.item_type)) current.benefitOther += li.amount
    }

    byEmployee.set(sre.employee_id, current)
  }

  if (byEmployee.size === 0) {
    return NextResponse.json({ error: `Inga bokförda lönekörningar för ${yearNum}` }, { status: 404 })
  }

  const companyData: KU10CompanyData = {
    orgNumber: (settings?.org_number || company.org_number || '').trim(),
    companyName: company.name,
    year: yearNum,
    contactName: (profile?.full_name || company.name || '').trim(),
    contactPhone: (settings?.phone || '').trim(),
    contactEmail: (settings?.email || profile?.email || user.email || '').trim(),
  }

  const r = (x: number) => Math.round(x * 100) / 100
  const employeeData: KU10EmployeeData[] = Array.from(byEmployee.values()).map(emp => ({
    personnummer: emp.personnummer,
    specificationNumber: emp.specificationNumber,
    totalGross: r(emp.totalGross),
    totalTax: r(emp.totalTax),
    totalAvgifterBasis: r(emp.totalAvgifterBasis),
    benefitCar: emp.benefitCar > 0 ? r(emp.benefitCar) : undefined,
    benefitHousing: emp.benefitHousing > 0 ? r(emp.benefitHousing) : undefined,
    benefitMeals: emp.benefitMeals > 0 ? r(emp.benefitMeals) : undefined,
    benefitOther: emp.benefitOther > 0 ? r(emp.benefitOther) : undefined,
    employmentStart: emp.employmentStart || undefined,
    employmentEnd: emp.employmentEnd || undefined,
  }))

  const xml = generateKU10Xml(companyData, employeeData)

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="KU10_${company.org_number}_${yearNum}.xml"`,
    },
  })
}
