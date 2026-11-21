import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { reopenQuestion } from '@/lib/questions/app-answer'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * POST /api/questions/[id]/reopen: undo an answer or a close made in the app.
 * The question is open again and the fact the answer saved is retired. Only
 * the person who ended it, within ten minutes; otherwise 409
 * COMPANY_QUESTION_UNDO_REFUSED.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'questions.reopen',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    const reopened = await reopenQuestion(supabase, createServiceClient(), {
      companyId,
      questionId: id,
      userId: user.id,
    })
    return NextResponse.json({ data: { question_id: reopened.question_id } })
  },
  { requireWrite: true },
)
