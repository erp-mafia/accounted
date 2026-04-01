import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { validateBalanceContinuity } from '@/lib/reports/continuity-check'
import { requireCompanyId } from '@/lib/company/context'

/**
 * GET: Validate IB/UB continuity for a fiscal period.
 * Query param: period_id (required)
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  try {
    const result = await validateBalanceContinuity(supabase, companyId, periodId)
    return NextResponse.json({ data: result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to validate continuity' },
      { status: 400 }
    )
  }
}
