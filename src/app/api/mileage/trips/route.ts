import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateMileageTripSchema } from '@/lib/api/schemas'
import { createTrip, listTrips } from '@/lib/mileage/mileage-service'

ensureInitialized()

export const GET = withRouteContext('mileage.trips.list', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')

  const trips = await listTrips(supabase, companyId, {
    from: searchParams.get('from') || undefined,
    to: searchParams.get('to') || undefined,
    status: status === 'draft' || status === 'booked' ? status : undefined,
    employeeId: searchParams.get('employee_id') || undefined,
  })

  return NextResponse.json({ data: trips })
})

export const POST = withRouteContext(
  'mileage.trips.create',
  async (request, { supabase, companyId, user }) => {
    const validation = await validateBody(request, CreateMileageTripSchema)
    if (!validation.success) return validation.response

    const trip = await createTrip(supabase, companyId, user.id, validation.data)
    return NextResponse.json({ data: trip }, { status: 201 })
  },
  { requireWrite: true }
)
