/**
 * The question behind a saved fact. An answered question keeps the id of the
 * fact that answered it (company_questions.fact_id); this reads, for facts of
 * one company, the question each one answered and the answer as the person
 * gave it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isCompanyQuestionsEnabled } from '@/lib/env/company-questions-switch'
import { createLogger } from '@/lib/logger'
import { answerAsGiven } from './answer-fact'
import { toQuestion, type QuestionRow } from './rows'

const log = createLogger('questions')

/** Fact ids per read: well under the gateway's request-line limit. */
const FACT_ID_CHUNK = 100

/** The question a fact answered, with the answer as the person gave it. */
export interface AnsweredQuestionOfFact {
  question: string
  /** The label of the option the person chose, or the text they wrote. */
  answer: string
}

/**
 * The answered question behind each fact, by fact id. A fact has one when a
 * question of the same company names it (fact_id) and was answered with an
 * option or a written answer; the earliest answered when several name it. A
 * question answered by a saved fact alone adds nothing: it carries no answer
 * of the person's own.
 *
 * Read with `supabase`: a reader gets the questions their own access to
 * company_questions gives them, and none otherwise. Best-effort: none when
 * the question list is not switched on for the company, and none for the
 * facts of a read that fails (with a log line).
 */
export async function answeredQuestionsOfFacts(
  supabase: SupabaseClient,
  companyId: string,
  factIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, AnsweredQuestionOfFact>> {
  const found = new Map<string, AnsweredQuestionOfFact>()
  if (!isCompanyQuestionsEnabled(companyId)) return found
  const ids = [...new Set(factIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const asked = new Set(ids)
  for (let at = 0; at < ids.length; at += FACT_ID_CHUNK) {
    const { data, error } = await supabase
      .from('company_questions')
      .select(
        'id, company_id, status, close_reason, question, why, options, evidence, actor_label, client, answer_option, answer_text, answered_at, answered_via, fact_id, created_at',
      )
      .eq('company_id', companyId)
      .eq('status', 'answered')
      .in('fact_id', ids.slice(at, at + FACT_ID_CHUNK))
      .order('answered_at', { ascending: true })
    if (error) {
      log.warn('the questions behind saved facts could not be read', { companyId, error: error.message })
      continue
    }
    for (const row of (data ?? []) as Array<QuestionRow & { company_id?: string | null }>) {
      // Only what was asked for is handed on, whatever the read answers.
      if (row.company_id !== companyId || row.status !== 'answered') continue
      if (!row.fact_id || !asked.has(row.fact_id) || found.has(row.fact_id)) continue
      const answer = answerAsGiven(toQuestion(row))
      if (answer) found.set(row.fact_id, { question: row.question, answer })
    }
  }
  return found
}
