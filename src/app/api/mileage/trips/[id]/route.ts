import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateMileageTripSchema } from '@/lib/api/schemas'

ensureInitialized()

type Params = { params: Promise<{ id: string }> }

/**
 * A booked trip is körjournal underlag for its verifikat: immutable and
 * undeletable (DB trigger backstops the delete). Only drafts can change.
 */
export const PATCH = withRouteContext<Params>(
  'mileage.trips.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, UpdateMileageTripSchema)
    if (!validation.success) return validation.response

    const { data: existing } = await supabase
      .from('mileage_trips')
      .select('id, status, vehicle_type, vehicle_registration')
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json({ error: 'Resan hittades inte' }, { status: 404 })
    }
    if (existing.status !== 'draft') {
      return NextResponse.json(
        { error: 'Resan är bokförd och kan inte ändras. Makulera verifikatet först.' },
        { status: 409 }
      )
    }

    // The employees FK is not company-scoped: verify a newly assigned
    // employee belongs to this company (mirrors createTrip).
    if (validation.data.employee_id) {
      const { data: employee } = await supabase
        .from('employees')
        .select('id')
        .eq('company_id', companyId)
        .eq('id', validation.data.employee_id)
        .maybeSingle()
      if (!employee) {
        return NextResponse.json(
          { error: 'Den anställda hittades inte i företaget' },
          { status: 400 }
        )
      }
    }

    // Enforce the förmånsbil regnr rule on the EFFECTIVE row (partial update
    // merged over the stored values), mirroring CreateMileageTripSchema.
    const effectiveVehicleType = validation.data.vehicle_type ?? existing.vehicle_type
    const effectiveRegistration =
      validation.data.vehicle_registration !== undefined
        ? validation.data.vehicle_registration
        : existing.vehicle_registration
    if (effectiveVehicleType !== 'own_car' && !effectiveRegistration?.trim()) {
      return NextResponse.json(
        { error: 'Ange registreringsnummer för förmånsbilen' },
        { status: 400 }
      )
    }

    const { data: updated, error } = await supabase
      .from('mileage_trips')
      .update(validation.data)
      .eq('company_id', companyId)
      .eq('id', id)
      .eq('status', 'draft')
      .select()
      .single()

    if (error || !updated) {
      return NextResponse.json({ error: 'Resan kunde inte uppdateras' }, { status: 500 })
    }
    return NextResponse.json({ data: updated })
  },
  { requireWrite: true }
)

export const DELETE = withRouteContext<Params>(
  'mileage.trips.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data: existing } = await supabase
      .from('mileage_trips')
      .select('id, status')
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json({ error: 'Resan hittades inte' }, { status: 404 })
    }
    if (existing.status !== 'draft') {
      return NextResponse.json(
        { error: 'Resan är bokförd och kan inte tas bort (underlag bevaras enligt bokföringslagen).' },
        { status: 409 }
      )
    }

    const { error } = await supabase
      .from('mileage_trips')
      .delete()
      .eq('company_id', companyId)
      .eq('id', id)
      .eq('status', 'draft')

    if (error) {
      return NextResponse.json({ error: 'Resan kunde inte tas bort' }, { status: 500 })
    }
    return NextResponse.json({ data: { deleted: true } })
  },
  { requireWrite: true }
)
