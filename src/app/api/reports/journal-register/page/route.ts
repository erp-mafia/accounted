import { NextResponse } from 'next/server'
import { generateJournalRegisterPage, type JournalRegisterCursor } from '@/lib/reports/journal-register'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isUuid } from '@/lib/invariants/uuid'

/**
 * The grundbok a page at a time, in registration order. Without a cursor
 * the first page, with the period's totals; `after_series`, `after_number`
 * and `after_id` (the last verifikat shown, as `next` returned it) continue.
 */
export const GET = withRouteContext('report.journal_register.page', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const afterSeries = searchParams.get('after_series')
  const afterNumber = searchParams.get('after_number')
  const afterId = searchParams.get('after_id')
  let after: JournalRegisterCursor | undefined
  if (afterSeries !== null || afterNumber !== null || afterId !== null) {
    if (!afterSeries || afterSeries.length > 100 || !afterNumber || !/^\d+$/.test(afterNumber) || !isUuid(afterId)) {
      return NextResponse.json({ error: 'after_series, after_number and after_id go together' }, { status: 400 })
    }
    after = { voucher_series: afterSeries, voucher_number: Number(afterNumber), id: afterId as string }
  }

  const data = await generateJournalRegisterPage(supabase, companyId, periodId, { after })

  return NextResponse.json({ data })
})
