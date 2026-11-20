import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { filedVatPeriodsOfDates, type FiledVatPeriod } from '@/lib/vat/filed-period-for-date'

/**
 * GET /api/bookkeeping/fiscal-periods/period-status?date=YYYY-MM-DD
 *
 * Read-only preview of whether a verifikation with the given entry_date could
 * be posted right now (company lock date + period is_closed/locked_at), plus
 * the covering period's label so the UI can show "flyttas till <år>" before a
 * write is attempted. Mirrors resolvePeriodStatusForDate / the DB triggers.
 *
 * `filed_vat` names the momsperiod the date lies in when its declaration is
 * on record as filed (lib/vat/filed-period-for-date.ts): filing locks
 * nothing, so an open date there still posts and changes a declaration
 * already filed. Null when none is, and when the filing record could not be
 * read: the lock verdict is the answer, this is what the screen adds to it.
 */
export const GET = withRouteContext('period.status_for_date', async (request, ctx) => {
  const { supabase, companyId, log } = ctx

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

    let filed_vat: FiledVatPeriod | null = null
    try {
      filed_vat = (await filedVatPeriodsOfDates(supabase, companyId, [date])).get(date) ?? null
    } catch (err) {
      log.warn('filed VAT period lookup failed for a period status', {
        date,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    return NextResponse.json({
      data: {
        status: status.status,
        period_id: status.period_id,
        lock_date: status.lock_date,
        period_name,
        filed_vat,
      },
    })
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          code: 'PERIOD_STATUS_ERROR',
          message: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte hämta periodstatus',
        },
      },
      { status: 500 }
    )
  }
})
