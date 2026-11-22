/**
 * The question list as a person's own doors: the open questions with the
 * records they rest on, an answer the person gives themselves, and its undo.
 * The doors are the app and the WhatsApp chat (PERSON_DOORS); the one an
 * answer or a close came through is recorded on the question.
 *
 * A person's answer is a saved fact, as it is from every other door: the
 * question and the answer in one sentence ("<question> Svar: <answer>"),
 * saved to agent_memory as the person's own (source user_taught), and the
 * question marked answered with it. "Vet inte" and "Fråga inte om sådant
 * här" close the question and save nothing.
 *
 * Undo (reopenQuestion) puts back what the app's own answer or close did:
 * the question is open again and the fact that answer saved is retired. Only
 * the person who answered, only for ten minutes, and only an answer given in
 * the app: a fact saved through another door is never retired from here.
 *
 * Two clients: `supabase` reads the question and saves the fact, `admin` is
 * the service role, which alone writes company_questions. In the app
 * `supabase` is the signed-in person's, under their own access. A door
 * without a session (the chat) checks the person's membership itself and
 * passes the service role as both. Every query filters company_id on both.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { badArgument, codedRefusal } from '@/lib/errors/refusal'
import { isCompanyQuestionsEnabled } from '@/lib/env/company-questions-switch'
import { isUuid } from '@/lib/invariants/uuid'
import { createLogger } from '@/lib/logger'
import { answerQuestion, closeQuestion } from './answer'
import { emitQuestionEvent } from './events'
import { evidenceLines, type EvidenceLine } from './evidence-lines'
import { listQuestions } from './list'
import { assertCompanyQuestionsOn, questionNotFound, readQuestionRow, toQuestion, type QuestionRow } from './rows'
import { QUESTION_LIMITS, type CompanyQuestion, type QuestionOption } from './types'

const log = createLogger('questions')

/** The door name the app's answers and closes are recorded with. */
export const APP_DOOR = 'app'

/** The door name the WhatsApp chat's answers and closes are recorded with. */
export const WHATSAPP_DOOR = 'whatsapp'

/** The doors a person answers through themselves. */
export const PERSON_DOORS = [APP_DOOR, WHATSAPP_DOOR] as const
export type PersonDoor = (typeof PERSON_DOORS)[number]

/** How long the person who answered may undo it. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000

/** An answer in the person's own words: short enough that the question and the answer fit one fact. */
export const APP_ANSWER_MAX = 1000

/** The ways a person closes a question without an answer. */
export const APP_CLOSE_REASONS = ['dont_know', 'not_relevant'] as const
export type AppCloseReason = (typeof APP_CLOSE_REASONS)[number]

export type AnswerLocale = 'sv' | 'en'

/** An open question as the app lists it. */
export interface AppQuestion {
  question_id: string
  question: string
  why: string | null
  options: QuestionOption[]
  evidence: EvidenceLine[]
  asked_at: string
}

/** The source_ref of the fact a person's answer saves. */
export function questionFactRef(questionId: string): string {
  return `question:${questionId}`
}

/** The fact an answer becomes: the question and the answer in one sentence. */
export function answerFactContent(question: string, answer: string, locale: AnswerLocale): string {
  return `${question.trim()} ${locale === 'en' ? 'Answer' : 'Svar'}: ${answer.trim()}`
}

/** The company's open questions with their evidence lines, the oldest first. */
export async function listAppQuestions(supabase: SupabaseClient, companyId: string): Promise<AppQuestion[]> {
  const open = await listQuestions(supabase, companyId, { status: 'open', limit: QUESTION_LIMITS.maxOpen })
  const lines = await evidenceLines(
    supabase,
    companyId,
    open.map((question) => question.evidence),
  )
  return open.map((question, index) => ({
    question_id: question.question_id,
    question: question.question,
    why: question.why,
    options: question.options,
    evidence: lines[index] ?? [],
    asked_at: question.created_at,
  }))
}

/**
 * How many questions are open, for Hem's row. Best-effort: none when the list
 * is not switched on, and none (with a log line) when the read fails.
 */
export async function countOpenQuestions(supabase: SupabaseClient, companyId: string): Promise<number> {
  if (!isCompanyQuestionsEnabled(companyId)) return 0
  const { count, error } = await supabase
    .from('company_questions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'open')
  if (error) {
    log.warn('open questions could not be counted', { companyId, error: error.message })
    return 0
  }
  return Math.min(count ?? 0, QUESTION_LIMITS.maxOpen)
}

async function readQuestion(supabase: SupabaseClient, companyId: string, questionId: string): Promise<CompanyQuestion> {
  return toQuestion(await readQuestionRow(supabase, companyId, questionId))
}

/** Retires a fact a person's answer saved. Only that fact: it carries the question's source_ref. */
async function retireAnswerFact(supabase: SupabaseClient, companyId: string, questionId: string, factId: string): Promise<void> {
  const { error } = await supabase
    .from('agent_memory')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', factId)
    .eq('company_id', companyId)
    .eq('source_ref', questionFactRef(questionId))
  if (error) throw dbError(error)
}

export interface AnswerAsPersonInput {
  companyId: string
  questionId: string
  /** One of the question's options, or */
  optionId?: string | null
  /** an answer in the person's own words. */
  text?: string | null
  /** The person who answers. */
  userId: string
  locale: AnswerLocale
  /** The door the answer comes through. */
  door: PersonDoor
}

export interface PersonAnswer {
  question: CompanyQuestion
  fact_id: string
  /** The sentence that was saved. */
  fact: string
}

/**
 * Answers an open question as the person, through one of their doors: saves
 * the fact, then marks the question answered with it and the door. When the
 * question turns out to have ended in between, the fact just saved is
 * retired and the refusal is thrown.
 */
export async function answerAsPerson(supabase: SupabaseClient, admin: SupabaseClient, input: AnswerAsPersonInput): Promise<PersonAnswer> {
  assertCompanyQuestionsOn(input.companyId)
  const optionId = typeof input.optionId === 'string' && input.optionId.trim() ? input.optionId.trim() : null
  const text = typeof input.text === 'string' && input.text.trim() ? input.text.trim() : null
  if ((optionId === null) === (text === null)) {
    throw badArgument('answer', 'give either option_id or text', 'Ange antingen ett svarsalternativ eller ett eget svar.')
  }
  if (text && text.length > APP_ANSWER_MAX) {
    throw badArgument('text', `text is ${text.length} characters; at most ${APP_ANSWER_MAX}`, `Högst ${APP_ANSWER_MAX} tecken.`)
  }

  const current = await readQuestion(supabase, input.companyId, input.questionId)
  if (current.status !== 'open') {
    throw codedRefusal('COMPANY_QUESTION_ALREADY_ENDED', `Question ${current.question_id} is already ${current.status}; a question ends once.`)
  }
  const option = optionId ? current.options.find((entry) => entry.id === optionId) : undefined
  if (optionId && !option) {
    throw badArgument('option_id', `option_id "${optionId}" is not an option of this question`, 'Svarsalternativet finns inte på frågan.')
  }

  const fact = answerFactContent(current.question, option ? option.label : (text as string), input.locale)
  const { data: saved, error: factError } = await supabase
    .from('agent_memory')
    .insert({
      company_id: input.companyId,
      kind: 'fact',
      content: fact,
      source: 'user_taught',
      source_ref: questionFactRef(current.question_id),
      relevance_score: 1,
      is_active: true,
      created_by_user_id: input.userId,
    })
    .select('id')
    .single()
  if (factError) throw dbError(factError)
  const factId = (saved as { id: string }).id

  try {
    const question = await answerQuestion(admin, {
      companyId: input.companyId,
      questionId: current.question_id,
      option: optionId,
      text,
      factId,
      userId: input.userId,
      via: input.door,
    })
    return { question, fact_id: factId, fact }
  } catch (error) {
    // The question ended in between: the fact answers nothing, so it is taken back.
    await retireAnswerFact(supabase, input.companyId, current.question_id, factId).catch((retireError: unknown) => {
      log.warn('a fact saved for a question that could not be answered was not retired', {
        companyId: input.companyId,
        questionId: current.question_id,
        factId,
        error: retireError instanceof Error ? retireError.message : String(retireError),
      })
    })
    throw error
  }
}

export interface CloseAsPersonInput {
  companyId: string
  questionId: string
  reason: AppCloseReason
  /** The person who closes it. */
  userId: string
  /** The door the close comes through. */
  door: PersonDoor
}

/** Closes an open question as the person, without an answer, through one of their doors. */
export async function closeAsPerson(admin: SupabaseClient, input: CloseAsPersonInput): Promise<CompanyQuestion> {
  if (!(APP_CLOSE_REASONS as readonly unknown[]).includes(input.reason)) {
    throw badArgument('reason', `reason must be one of ${APP_CLOSE_REASONS.join(', ')}`, `Skälet måste vara ett av ${APP_CLOSE_REASONS.join(', ')}.`)
  }
  return closeQuestion(admin, {
    companyId: input.companyId,
    questionId: input.questionId,
    reason: input.reason,
    userId: input.userId,
    via: input.door,
  })
}

function undoRefused(questionId: string, why: string): Error {
  return codedRefusal('COMPANY_QUESTION_UNDO_REFUSED', `Question ${questionId} cannot be reopened: ${why}.`)
}

export interface ReopenQuestionInput {
  companyId: string
  questionId: string
  userId: string
  /** The clock, for tests. */
  now?: Date
}

/**
 * Undoes an answer or a close made in the app: the question is open again,
 * and the fact the answer saved is retired. Refuses a question that is still
 * open, one somebody else ended, one ended through another door, and one
 * ended more than ten minutes ago. A reopened question emits
 * company_question.reopened.
 */
export async function reopenQuestion(supabase: SupabaseClient, admin: SupabaseClient, input: ReopenQuestionInput): Promise<CompanyQuestion> {
  assertCompanyQuestionsOn(input.companyId)
  if (!isUuid(input.questionId)) throw questionNotFound(input.questionId)

  const { data, error } = await supabase
    .from('company_questions')
    .select('id, status, answered_by, answered_at, answered_via, fact_id')
    .eq('id', input.questionId)
    .eq('company_id', input.companyId)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) throw questionNotFound(input.questionId)
  const current = data as {
    id: string
    status: string
    answered_by: string | null
    answered_at: string | null
    answered_via: string | null
    fact_id: string | null
  }

  if (current.status === 'open' || !current.answered_at) throw undoRefused(current.id, 'it is open')
  if (current.answered_by !== input.userId) throw undoRefused(current.id, 'it was ended by someone else')
  if (current.answered_via !== APP_DOOR) throw undoRefused(current.id, 'it was not ended in the app')
  const now = (input.now ?? new Date()).getTime()
  if (now - new Date(current.answered_at).getTime() > UNDO_WINDOW_MS) throw undoRefused(current.id, 'it ended more than ten minutes ago')

  const { data: reopened, error: reopenError } = await admin
    .from('company_questions')
    .update({
      status: 'open',
      close_reason: null,
      answer_option: null,
      answer_text: null,
      fact_id: null,
      answered_by: null,
      answered_at: null,
      answered_via: null,
    })
    .eq('id', current.id)
    .eq('company_id', input.companyId)
    .eq('status', current.status)
    .eq('answered_by', input.userId)
    .select(
      'id, status, close_reason, question, why, options, evidence, actor_label, client, answer_option, answer_text, answered_at, answered_via, fact_id, created_at',
    )
    .maybeSingle()
  if (reopenError) throw dbError(reopenError)
  if (!reopened) throw undoRefused(current.id, 'it changed in between')

  await emitQuestionEvent({
    type: 'company_question.reopened',
    payload: { questionId: current.id, userId: input.userId, companyId: input.companyId },
  })
  if (current.fact_id) await retireAnswerFact(supabase, input.companyId, current.id, current.fact_id)
  return toQuestion(reopened as QuestionRow)
}
