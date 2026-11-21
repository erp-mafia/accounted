import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listAppQuestions } from '@/lib/questions/app-answer'

/**
 * GET /api/questions: the active company's open questions, the oldest first,
 * each with the records it rests on as readable lines (date, name, amount,
 * link). Every member may read them. 409 COMPANY_QUESTIONS_OFF for a company
 * the question list is not switched on for.
 */
export const GET = withRouteContext('questions.list', async (_request, { supabase, companyId }) => {
  const questions = await listAppQuestions(supabase, companyId)
  return NextResponse.json({ data: questions })
})
