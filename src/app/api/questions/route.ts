import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listQuestionPage } from '@/lib/questions/app-answer'

/**
 * GET /api/questions: the active company's open questions, the oldest first,
 * each with the records it rests on as readable lines (date, name, amount,
 * link). After them the questions closed as settled in the last 90 days, the
 * latest first, each with `settled`: the note of its close and the records
 * the close named, as the same lines. Every member may read them. 409
 * COMPANY_QUESTIONS_OFF for a company the question list is not switched on
 * for.
 */
export const GET = withRouteContext('questions.list', async (_request, { supabase, companyId }) => {
  const questions = await listQuestionPage(supabase, companyId)
  return NextResponse.json({ data: questions })
})
