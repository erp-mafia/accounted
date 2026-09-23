import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BookMileagePeriodSchema } from '@/lib/api/schemas'
import { bookMileagePeriod } from '@/lib/mileage/mileage-service'

ensureInitialized()

export const POST = withRouteContext(
  'mileage.book',
  async (request, { supabase, companyId, user, log }) => {
    const validation = await validateBody(request, BookMileagePeriodSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const result = await bookMileagePeriod(supabase, companyId, user.id, {
      from: body.from,
      to: body.to,
      entryDate: body.entry_date,
      counterAccount: body.counter_account,
      employeeId: body.employee_id,
    })

    if (!result.ok) {
      if (result.code === 'NO_TRIPS') {
        return NextResponse.json(
          { error: 'Inga obokförda resor i den valda perioden' },
          { status: 400 }
        )
      }
      if (result.code === 'MIXED_EMPLOYEES') {
        return NextResponse.json(
          { error: 'Resorna i perioden gäller flera anställda. Bokför per anställd.' },
          { status: 400 }
        )
      }
      if (result.code === 'PERIOD_NOT_OPEN') {
        return NextResponse.json(
          { error: 'Bokföringsdatumet ligger i en stängd eller låst period' },
          { status: 400 }
        )
      }
      if (result.code === 'CLAIM_LOST' || result.code === 'TRIPS_CHANGED') {
        return NextResponse.json(
          { error: 'Körjournalen ändrades samtidigt av en annan bokning. Ladda om och försök igen.' },
          { status: 409 }
        )
      }
      // STAMP_FAILED: the verifikat exists but some trips could not be marked
      // as booked. Surface loudly so the user does not book the period twice.
      log.error('mileage stamp failed after verifikat creation', undefined, {
        operation: 'mileage.book',
        companyId,
        entityType: 'journal_entry',
        entityId: result.journalEntryId,
      })
      return NextResponse.json(
        {
          error:
            'Verifikatet skapades men alla resor kunde inte markeras som bokförda. Kontrollera körjournalen innan du bokför perioden igen.',
        },
        { status: 500 }
      )
    }

    return NextResponse.json({
      data: {
        journal_entry_id: result.journalEntryId,
        voucher_series: result.voucherSeries,
        voucher_number: result.voucherNumber,
        trip_count: result.tripCount,
        total_amount: result.totalAmount,
        summaries: result.summaries,
      },
    })
  },
  { requireWrite: true }
)
