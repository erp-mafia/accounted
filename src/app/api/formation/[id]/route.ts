import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { formationAnswersSchema } from '@/lib/formation/answers'
import { formationRoute } from '@/lib/formation/route'
import { FormationStateError, saveAnswers, toView } from '@/lib/formation/store'

/** PUT /api/formation/:id: save the answers (autosave from the interview). */
const SaveSchema = z.object({ answers: formationAnswersSchema })

export const PUT = formationRoute<{ params: Promise<{ id: string }> }>('formation.save', async (request, { user, service }, { params }) => {
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) throw new FormationStateError('FORMATION_NOT_FOUND')
  const validation = await validateBody(request, SaveSchema)
  if (!validation.success) return validation.response
  const row = await saveAnswers(service, user.id, id, validation.data.answers)
  return NextResponse.json({ data: toView(row) })
})
