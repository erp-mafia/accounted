import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { formationRoute } from '@/lib/formation/route'
import { markSubmitted, toView } from '@/lib/formation/store'
import { codedRefusal } from '@/lib/errors/refusal'

/**
 * POST /api/formation/:id/submitted: every founder has signed the
 * stiftelseurkund and the application is sent in. The deed date becomes
 * the date of the first aktiebok entries; it can never be in the future.
 */
const SubmittedSchema = z.object({ deed_date: saneIsoDateSchema })

export const POST = formationRoute<{ params: Promise<{ id: string }> }>('formation.submitted', async (request, { user, service }, { params }) => {
  const { id } = await params
  const validation = await validateBody(request, SubmittedSchema)
  if (!validation.success) return validation.response
  const deedDate = validation.data.deed_date
  if (deedDate > todayIsoStockholm()) {
    throw codedRefusal('FORMATION_DEED_DATE_INVALID', 'The deed date is not a date or lies in the future.')
  }
  const row = await markSubmitted(service, user.id, id, deedDate)
  return NextResponse.json({ data: toView(row) })
})
