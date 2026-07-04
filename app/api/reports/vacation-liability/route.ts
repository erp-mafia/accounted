import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { generateVacationLiability } from '@/lib/reports/vacation-liability'

/**
 * Semesterlöneskuld report, per BFNAR 2016:10 kap 16.
 * Per-employee vacation liability (accounts 2920 + 2940).
 * Required for year-end closing.
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString())

  try {
    const report = await generateVacationLiability(supabase, companyId, year)
    return NextResponse.json({ data: report })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Kunde inte generera semesterlöneskuld'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
