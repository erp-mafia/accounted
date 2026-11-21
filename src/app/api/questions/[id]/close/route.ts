import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { APP_CLOSE_REASONS, APP_DOOR, closeAsPerson } from '@/lib/questions/app-answer'
import { createServiceClient } from '@/lib/supabase/server'

const CloseSchema = z.object({ reason: z.enum(APP_CLOSE_REASONS) }).strict()

/**
 * POST /api/questions/[id]/close: close an open question without an answer.
 * `dont_know` when the person cannot say, `not_relevant` when they do not
 * want it asked. Nothing is saved as a fact.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'questions.close',
  async (request, { companyId, user, log }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, CloseSchema, { log, operation: 'questions.close' })
    if (!validation.success) return validation.response

    const closed = await closeAsPerson(createServiceClient(), {
      companyId,
      questionId: id,
      reason: validation.data.reason,
      userId: user.id,
      door: APP_DOOR,
    })
    return NextResponse.json({ data: { question_id: closed.question_id, close_reason: closed.close_reason } })
  },
  { requireWrite: true },
)
