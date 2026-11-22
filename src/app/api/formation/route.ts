import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { formationAnswersSchema } from '@/lib/formation/answers'
import { formationRoute } from '@/lib/formation/route'
import { createFormation, currentFormation, toView } from '@/lib/formation/store'

/**
 * GET  /api/formation: the signed-in user's current company formation, or null.
 * POST /api/formation: start one (answers optional); answers the current one
 *      when it already exists, so a double click never makes two.
 */
export const GET = formationRoute('formation.get', async (_request, { user, service }) => {
  const row = await currentFormation(service, user.id)
  return NextResponse.json({ data: row ? toView(row) : null })
})

const CreateSchema = z.object({ answers: formationAnswersSchema.optional() })

export const POST = formationRoute('formation.create', async (request, { user, service }) => {
  const validation = await validateBody(request, CreateSchema)
  if (!validation.success) return validation.response
  const existing = await currentFormation(service, user.id)
  if (existing && existing.status !== 'set_up') return NextResponse.json({ data: toView(existing) })
  const answers = validation.data.answers ?? formationAnswersSchema.parse({})
  if (!answers.contact.email && user.email) answers.contact.email = user.email
  const row = await createFormation(service, user.id, answers)
  return NextResponse.json({ data: toView(row) }, { status: 201 })
})
