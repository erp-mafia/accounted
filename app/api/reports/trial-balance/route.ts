import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export const GET = withRouteContext('report.trial_balance', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  try {
    const result = await generateTrialBalance(supabase, companyId, periodId, { closingEntry: 'include' })
    return NextResponse.json({ data: result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Failed to generate trial balance' },
      { status: 500 }
    )
  }
})
