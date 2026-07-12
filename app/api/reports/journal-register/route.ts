import { NextResponse } from 'next/server'
import { generateJournalRegister } from '@/lib/reports/journal-register'
import { withRouteContext } from '@/lib/api/with-route-context'

export const GET = withRouteContext('report.journal_register', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const data = await generateJournalRegister(supabase, companyId, periodId)

  return NextResponse.json({ data })
})
