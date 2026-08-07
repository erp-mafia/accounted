import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MileageSalaryPushSchema } from '@/lib/api/schemas'
import { pushMileageToSalaryRun } from '@/lib/mileage/mileage-service'

ensureInitialized()

export const POST = withRouteContext(
  'mileage.salary_push',
  async (request, { supabase, companyId }) => {
    const validation = await validateBody(request, MileageSalaryPushSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const result = await pushMileageToSalaryRun(supabase, companyId, {
      runId: body.run_id,
      employeeId: body.employee_id,
      from: body.from,
      to: body.to,
      includeUnassigned: body.include_unassigned,
    })

    if (!result.ok) {
      switch (result.code) {
        case 'RUN_NOT_FOUND':
          return NextResponse.json({ error: 'Lönekörningen hittades inte' }, { status: 404 })
        case 'EMPLOYEE_NOT_IN_RUN':
          return NextResponse.json(
            { error: 'Den anställda ingår inte i lönekörningen' },
            { status: 404 }
          )
        case 'RUN_NOT_EDITABLE':
          return NextResponse.json(
            { error: 'Lönekörningen kan inte längre ändras' },
            { status: 409 }
          )
        case 'NO_TRIPS':
          return NextResponse.json(
            { error: 'Inga obokförda resor i den valda perioden' },
            { status: 400 }
          )
        case 'CLAIM_LOST':
          return NextResponse.json(
            { error: 'Körjournalen ändrades samtidigt av en annan bokning. Ladda om och försök igen.' },
            { status: 409 }
          )
      }
    }

    return NextResponse.json({
      data: {
        trip_count: result.tripCount,
        total_amount: result.totalAmount,
        summaries: result.summaries,
      },
    })
  },
  { requireWrite: true }
)
