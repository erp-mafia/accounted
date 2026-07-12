import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'

/**
 * GET /api/bookkeeping/fiscal-periods/period-status?date=YYYY-MM-DD
 *
 * Read-only preview of whether a verifikation with the given entry_date could
 * be posted right now (company lock date + period is_closed/locked_at), plus
 * the covering period's label so the UI can show "flyttas till <år>" before a
 * write is attempted. Mirrors resolvePeriodStatusForDate / the DB triggers.
 */
export const GET = withRouteContext('period.status_for_date', async (request, ctx) => {
  const { supabase, companyId } = ctx

  const date = new URL(request.url).searchParams.get('date')
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Ogiltigt datum (förväntat ÅÅÅÅ-MM-DD)' }, { status: 400 })
  }

  try {
    const status = await resolvePeriodStatusForDate(supabase, companyId, date)

    let period_name: string | null = null
    if (status.period_id) {
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('name')
        .eq('id', status.period_id)
        .eq('company_id', companyId)
        .maybeSingle()
      period_name = period?.name ?? null
    }

    return NextResponse.json({
      data: {
        status: status.status,
        period_id: status.period_id,
        lock_date: status.lock_date,
        period_name,
      },
    })
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          code: 'PERIOD_STATUS_ERROR',
          message: err instanceof Error ? err.message : 'Kunde inte hämta periodstatus',
        },
      },
      { status: 500 }
    )
  }
})
