import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { listQuestionPage } from '@/lib/questions/app-answer'

/**
 * GET /api/questions: the active company's open questions, the oldest first,
 * each with the records it rests on as readable lines (date, name, amount,
 * link). After them the questions answered in the last 90 days, the latest
 * first, each with `answered`: the answer as the person gave it and when.
 * Then the questions closed as settled in the last 90 days, the latest
 * first, each with `settled`: the note of its close and the records the
 * close named, as the same lines. An answered and a settled question carry
 * `operations`: the staged operations linked to it (id, number, type, title,
 * status, the verifikat a committed one posted, the bank row it names with
 * its text and amount, and the file and the verifikat label its preview
 * names), read under the caller's own access to pending_operations and to
 * the bank rows. Every member may read the
 * questions. 409 COMPANY_QUESTIONS_OFF for a company the question list is
 * not switched on for.
 */
export const GET = withRouteContext('questions.list', async (_request, { supabase, companyId }) => {
  const questions = await listQuestionPage(supabase, companyId)
  return NextResponse.json({ data: questions })
})
