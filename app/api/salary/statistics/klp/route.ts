import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { z } from 'zod'
import {
  buildKlp,
  klpToTxt,
  MONTHLY_CONTRACT_HOURS,
  type KlpBucket,
  type KlpEmployeeRow,
} from '@/lib/salary/statistics/klp'

ensureInitialized()

const QuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  format: z.enum(['txt', 'json']).default('txt'),
})

// Line-item groupings → KLP concepts.
const OVERTIME_SUPPLEMENT = ['overtime', 'overtime_50', 'overtime_100']
const VARIABLE_SUPPLEMENT = ['bonus', 'commission', 'ob_weekday_evening', 'ob_weekend', 'ob_night', 'ob_holiday']
const SICK_PAY = ['sick_day2_14']
const BASE_HOURLY = ['hourly_salary']

function bucketFor(workerCategory: string | null, salaryType: string): KlpBucket {
  const cat = workerCategory ?? 'tjansteman' // default unclassified → tjänsteman
  if (cat === 'arbetare') return salaryType === 'hourly' ? 'at' : 'am'
  return 'tm'
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ange giltigt år och månad (1–12)' }, { status: 400 })
  }
  const { year, month, format } = parsed.data

  // UtbManad = utbetalningsmånad: match runs by payment_date within the month.
  const mm = String(month).padStart(2, '0')
  const from = `${year}-${mm}-01`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const to = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`

  const { data: runs, error: runsError } = await supabase
    .from('salary_runs')
    .select('id')
    .eq('company_id', companyId)
    .gte('payment_date', from)
    .lte('payment_date', to)
  if (runsError) {
    return NextResponse.json({ error: runsError.message }, { status: 500 })
  }

  const rows: KlpEmployeeRow[] = []
  let unclassified = 0
  const runIds = (runs ?? []).map(r => r.id as string)

  if (runIds.length > 0) {
    const { data: sres, error: sreError } = await supabase
      .from('salary_run_employees')
      .select('id, hours_worked, employee:employees(worker_category, salary_type, monthly_salary, employment_degree)')
      .eq('company_id', companyId)
      .in('salary_run_id', runIds)
    if (sreError) {
      return NextResponse.json({ error: sreError.message }, { status: 500 })
    }

    const sreList = sres ?? []
    const sreIds = sreList.map(s => s.id as string)

    // Sum the relevant line items per snapshot.
    const sums = new Map<string, { base: number; overtime: number; variable: number; sick: number }>()
    if (sreIds.length > 0) {
      const { data: items, error: itemsError } = await supabase
        .from('salary_line_items')
        .select('salary_run_employee_id, amount, item_type')
        .eq('company_id', companyId)
        .in('salary_run_employee_id', sreIds)
      if (itemsError) {
        return NextResponse.json({ error: itemsError.message }, { status: 500 })
      }
      for (const it of items ?? []) {
        const key = it.salary_run_employee_id as string
        const acc = sums.get(key) ?? { base: 0, overtime: 0, variable: 0, sick: 0 }
        const amount = Number(it.amount) || 0
        const type = it.item_type as string
        if (BASE_HOURLY.includes(type)) acc.base += amount
        if (OVERTIME_SUPPLEMENT.includes(type)) acc.overtime += amount
        if (VARIABLE_SUPPLEMENT.includes(type)) acc.variable += amount
        if (SICK_PAY.includes(type)) acc.sick += amount
        sums.set(key, acc)
      }
    }

    for (const s of sreList) {
      // Supabase types the embedded relation as an array; it's a to-one here.
      const emp = (Array.isArray(s.employee) ? s.employee[0] : s.employee) as {
        worker_category: string | null
        salary_type: string
        monthly_salary: number | null
        employment_degree: number
      } | null
      if (!emp) continue
      if (emp.worker_category == null) unclassified += 1

      const bucket = bucketFor(emp.worker_category, emp.salary_type)
      const degree = Number(emp.employment_degree) || 100
      const agreedHours = Math.round(MONTHLY_CONTRACT_HOURS * (degree / 100))
      const acc = sums.get(s.id as string) ?? { base: 0, overtime: 0, variable: 0, sick: 0 }
      const hoursWorked = s.hours_worked != null
        ? Number(s.hours_worked)
        : (bucket === 'at' ? 0 : agreedHours)

      rows.push({
        bucket,
        baseWage: bucket === 'at' ? acc.base : (Number(emp.monthly_salary) || 0),
        agreedHours,
        workedHours: hoursWorked,
        overtimeSupplement: acc.overtime,
        overtimeHours: 0,
        variableSupplement: acc.variable,
        sickPay: acc.sick,
        fteShare: degree / 100,
      })
    }
  }

  const now = new Date()
  const extractionDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

  const { data: company } = await supabase
    .from('companies')
    .select('org_number')
    .eq('id', companyId)
    .maybeSingle()

  const record = buildKlp(
    {
      orgNumber: company?.org_number ?? null,
      extractionDate,
      system: 'gnubok',
      version: '1.0',
      year,
      month,
    },
    rows,
  )

  if (format === 'json') {
    return NextResponse.json({ data: record, unclassified })
  }

  return new NextResponse(klpToTxt(record), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="KLP_${year}${mm}.txt"`,
    },
  })
}
