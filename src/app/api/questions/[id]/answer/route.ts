import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { localeFromCookieHeader } from '@/i18n/config'
import { APP_ANSWER_MAX, APP_DOOR, answerAsPerson } from '@/lib/questions/app-answer'
import { QUESTION_LIMITS } from '@/lib/questions/types'
import { createServiceClient } from '@/lib/supabase/server'

const AnswerSchema = z
  .object({
    option_id: z.string().trim().min(1).max(QUESTION_LIMITS.maxOptionId).optional(),
    text: z.string().trim().min(1).max(APP_ANSWER_MAX).optional(),
  })
  .strict()
  .refine((body) => (body.option_id === undefined) !== (body.text === undefined), {
    message: 'Ange antingen ett svarsalternativ eller ett eget svar.',
    params: { en: 'Give either option_id or text.' },
  })

/**
 * POST /api/questions/[id]/answer: answer an open question with one of its
 * options (`option_id`) or in the person's own words (`text`). The question
 * and the answer are saved as one fact, and the question is marked answered
 * with it. Answers `{ question_id, fact_id, fact }`: the sentence that was
 * saved.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'questions.answer',
  async (request, { supabase, companyId, user, log }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, AnswerSchema, { log, operation: 'questions.answer' })
    if (!validation.success) return validation.response

    const answered = await answerAsPerson(supabase, createServiceClient(), {
      companyId,
      questionId: id,
      optionId: validation.data.option_id ?? null,
      text: validation.data.text ?? null,
      userId: user.id,
      locale: localeFromCookieHeader(request.headers.get('cookie')),
      door: APP_DOOR,
    })
    return NextResponse.json({
      data: { question_id: answered.question.question_id, fact_id: answered.fact_id, fact: answered.fact },
    })
  },
  { requireWrite: true },
)
