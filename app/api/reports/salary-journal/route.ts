import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { generateSalaryJournal } from '@/lib/reports/salary-journal'

/**
 * Lönejournal report, per BFNAR 2013:2 behandlingshistorik requirement.
 * Monthly/annual per-employee salary register for AGI reconciliation.
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString())
  const monthFrom = searchParams.get('month_from') ? parseInt(searchParams.get('month_from')!) : undefined
  const monthTo = searchParams.get('month_to') ? parseInt(searchParams.get('month_to')!) : undefined

  try {
    const report = await generateSalaryJournal(supabase, companyId, year, monthFrom, monthTo)
    return NextResponse.json({ data: report })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Kunde inte generera lönejournal'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
