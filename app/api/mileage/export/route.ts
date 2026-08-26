import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { ISO_DATE_RE } from '@/lib/invariants'
import { listTrips } from '@/lib/mileage/mileage-service'
import { mileageTripsToCsv } from '@/lib/mileage/csv-export'

ensureInitialized()

/** Körjournal CSV export (Skatteverket audit underlag). */
export const GET = withRouteContext('mileage.export', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const from = searchParams.get('from') || undefined
  const to = searchParams.get('to') || undefined
  // Validated dates are also what the Content-Disposition filename is built
  // from, so nothing user-controlled reaches the header unchecked.
  for (const value of [from, to]) {
    if (value !== undefined && !ISO_DATE_RE.test(value)) {
      return NextResponse.json({ error: 'Ogiltigt datum (ÅÅÅÅ-MM-DD)' }, { status: 400 })
    }
  }

  const trips = await listTrips(supabase, companyId, { from, to })
  // Oldest first in the export: a körjournal reads chronologically.
  trips.reverse()

  const entryIds = [...new Set(trips.map((t) => t.journal_entry_id).filter(Boolean))] as string[]
  const voucherLabels = new Map<string, string>()
  if (entryIds.length > 0) {
    const { data: entries } = await supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number')
      .eq('company_id', companyId)
      .in('id', entryIds)
    for (const entry of entries || []) {
      voucherLabels.set(entry.id, `${entry.voucher_series}${entry.voucher_number}`)
    }
  }

  // Driver attribution (BFL 5 kap 6-7 §): name the employee per trip so a
  // multi-employee körjournal stays attributable in the exported underlag.
  const employeeIds = [...new Set(trips.map((t) => t.employee_id).filter(Boolean))] as string[]
  const driverLabels = new Map<string, string>()
  if (employeeIds.length > 0) {
    const { data: employees } = await supabase
      .from('employees')
      .select('id, first_name, last_name')
      .eq('company_id', companyId)
      .in('id', employeeIds)
    for (const employee of employees || []) {
      driverLabels.set(employee.id, `${employee.first_name} ${employee.last_name}`)
    }
  }

  const csv = mileageTripsToCsv(trips, voucherLabels, driverLabels)
  const suffix = [from, to].filter(Boolean).join('_')
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="korjournal${suffix ? `_${suffix}` : ''}.csv"`,
    },
  })
})
