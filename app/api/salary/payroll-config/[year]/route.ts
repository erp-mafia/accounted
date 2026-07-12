import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { loadPayrollConfig } from '@/lib/salary/payroll-config'

export const GET = withRouteContext<{ params: Promise<{ year: string }> }>(
  'salary.payroll_config.get',
  async (request, { supabase }, { params }) => {
    const { year } = await params

    const yearNum = parseInt(year)
    if (isNaN(yearNum) || yearNum < 2020 || yearNum > 2100) {
      return NextResponse.json({ error: 'Ogiltigt år' }, { status: 400 })
    }

    try {
      const config = await loadPayrollConfig(supabase, yearNum)
      return NextResponse.json({ data: config })
    } catch {
      return NextResponse.json({ error: `Löneuppgifter för ${year} saknas` }, { status: 404 })
    }
  },
)
