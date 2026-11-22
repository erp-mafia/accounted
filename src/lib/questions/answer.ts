/**
 * Ending a question: an answer (an option, a written answer or a saved
 * fact), or a close with its reason. A question ends once: a second answer
 * or close is refused and writes nothing. An answer emits
 * company_question.answered and a close company_question.closed, whichever
 * door it came through.
 *
 * A close with the reason settled may say where the answer is: a note and
 * the records that hold it. The records are held to what a question's own
 * evidence is held to when it is filed (evidence.ts): every one exists in
 * the company, and every money amount in the note stands on one of them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { badArgument, codedRefusal } from '@/lib/errors/refusal'
import { emitQuestionEvent } from './events'
import { assertStandsOnEvidence, evidenceRefsOf } from './evidence'
import { assertCompanyQuestionsOn, readQuestionRow, toQuestion, type QuestionRow } from './rows'
import { QUESTION_CLOSE_REASONS, QUESTION_LIMITS, type CompanyQuestion, type EvidenceRef, type QuestionCloseReason } from './types'

export interface AnswerQuestionInput {
  companyId: string
  questionId: string
  /** The id of one of the question's options. */
  option?: string | null
  /** A written answer. */
  text?: string | null
  /** The saved fact (agent_memory) that holds the answer. */
  factId?: string | null
  /** The person who answered, or the person the credential acts for. */
  userId: string | null
  /** The door the answer came through. */
  via?: string | null
}

export interface CloseQuestionInput {
  companyId: string
  questionId: string
  reason: unknown
  /** With the reason settled: where the answer is, at most QUESTION_LIMITS.maxCloseNote characters. Needs evidence. */
  note?: unknown
  /** With the reason settled: the records that hold the answer, as a question's evidence is given. */
  evidence?: unknown
  userId: string | null
  via?: string | null
}

function alreadyEnded(questionId: string, status: string): Error {
  return codedRefusal('COMPANY_QUESTION_ALREADY_ENDED', `Question ${questionId} is already ${status}; a question ends once.`)
}

/** The question as it stands, or a refusal when it is missing, in another company or already ended. */
async function openQuestion(supabase: SupabaseClient, companyId: string, questionId: string): Promise<QuestionRow> {
  const row = await readQuestionRow(supabase, companyId, questionId)
  if (row.status !== 'open') throw alreadyEnded(questionId, row.status)
  return row
}

function viaOf(via: string | null | undefined): string | null {
  const text = typeof via === 'string' ? via.trim() : ''
  return text ? text.slice(0, 60) : null
}

/** Marks an open question answered. Needs an option, a written answer or a fact. */
export async function answerQuestion(supabase: SupabaseClient, input: AnswerQuestionInput): Promise<CompanyQuestion> {
  assertCompanyQuestionsOn(input.companyId)
  const option = typeof input.option === 'string' && input.option.trim() ? input.option.trim() : null
  const text = typeof input.text === 'string' && input.text.trim() ? input.text.trim() : null
  const factId = typeof input.factId === 'string' && input.factId.trim() ? input.factId.trim() : null
  if (!option && !text && !factId) {
    throw badArgument('answer', 'an answer is required: an option, a written answer or a saved fact')
  }
  if (text && text.length > QUESTION_LIMITS.maxAnswerText) {
    throw badArgument(
      'answer_text',
      `answer_text is ${text.length} characters; at most ${QUESTION_LIMITS.maxAnswerText}`,
      `Högst ${QUESTION_LIMITS.maxAnswerText} tecken.`,
    )
  }

  const current = toQuestion(await openQuestion(supabase, input.companyId, input.questionId))
  if (option && !current.options.some((o) => o.id === option)) {
    const ids = current.options.map((o) => o.id).join(', ') || 'none'
    throw badArgument(
      'answer_option',
      `answer_option "${option}" is not an option of this question (options: ${ids})`,
      'Svarsalternativet finns inte på frågan.',
    )
  }

  // The status filter makes two answers at once write one.
  const { data, error } = await supabase
    .from('company_questions')
    .update({
      status: 'answered',
      answer_option: option,
      answer_text: text,
      fact_id: factId,
      answered_by: input.userId,
      answered_at: new Date().toISOString(),
      answered_via: viaOf(input.via),
    })
    .eq('id', current.question_id)
    .eq('company_id', input.companyId)
    .eq('status', 'open')
    .select(
      'id, status, close_reason, close_note, close_evidence, question, why, options, evidence, actor_label, client, answer_option, answer_text, answered_at, answered_via, fact_id, created_at',
    )
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) throw alreadyEnded(current.question_id, 'answered or closed')
  const answered = toQuestion(data as QuestionRow)
  await emitQuestionEvent({
    type: 'company_question.answered',
    payload: {
      questionId: answered.question_id,
      status: 'answered',
      answeredVia: answered.answered_via,
      answeredAt: answered.answered_at,
      userId: input.userId,
      companyId: input.companyId,
    },
  })
  return answered
}

/** The note of a close: trimmed, null when none was given. */
function closeNoteOf(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw badArgument('note', 'note must be a string', 'Måste vara text.')
  const note = value.trim()
  if (note.length > QUESTION_LIMITS.maxCloseNote) {
    throw badArgument(
      'note',
      `note is ${note.length} characters; at most ${QUESTION_LIMITS.maxCloseNote}`,
      `Högst ${QUESTION_LIMITS.maxCloseNote} tecken.`,
    )
  }
  return note || null
}

/** The records a close cites: none when none were given. */
function closeEvidenceOf(value: unknown): EvidenceRef[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw badArgument('evidence', 'evidence must be an array', 'Måste vara en lista.')
  return evidenceRefsOf(value)
}

/**
 * Closes an open question without an answer, with the reason. With the
 * reason settled it also takes a note and the records that hold the answer
 * (see the file header); a note needs at least one record, records need no
 * note, and either one with another reason is refused. Nothing is written
 * when a check fails.
 */
export async function closeQuestion(supabase: SupabaseClient, input: CloseQuestionInput): Promise<CompanyQuestion> {
  assertCompanyQuestionsOn(input.companyId)
  if (!(QUESTION_CLOSE_REASONS as readonly unknown[]).includes(input.reason)) {
    throw badArgument(
      'reason',
      `reason must be one of ${QUESTION_CLOSE_REASONS.join(', ')}`,
      `Skälet måste vara ett av ${QUESTION_CLOSE_REASONS.join(', ')}.`,
    )
  }
  const reason = input.reason as QuestionCloseReason
  const note = closeNoteOf(input.note)
  const evidence = closeEvidenceOf(input.evidence)
  if (reason !== 'settled' && (note !== null || evidence.length > 0)) {
    throw badArgument(
      note !== null ? 'note' : 'evidence',
      `note and evidence are taken only with the reason settled, not with ${reason}`,
      'En anteckning och underlag kan bara anges när frågan är löst av bokföringen.',
    )
  }
  if (note !== null && evidence.length === 0) {
    throw badArgument(
      'evidence',
      'a note needs evidence: cite at least one record that holds the answer',
      'En anteckning behöver minst ett underlag.',
    )
  }
  const current = await openQuestion(supabase, input.companyId, input.questionId)
  if (evidence.length > 0) await assertStandsOnEvidence(supabase, input.companyId, evidence, [note], 'note')

  const { data, error } = await supabase
    .from('company_questions')
    .update({
      status: 'closed',
      close_reason: reason,
      // Written only when the close says where the answer is.
      ...(evidence.length > 0 ? { close_note: note, close_evidence: evidence } : {}),
      answered_by: input.userId,
      answered_at: new Date().toISOString(),
      answered_via: viaOf(input.via),
    })
    .eq('id', current.id)
    .eq('company_id', input.companyId)
    .eq('status', 'open')
    .select(
      'id, status, close_reason, close_note, close_evidence, question, why, options, evidence, actor_label, client, answer_option, answer_text, answered_at, answered_via, fact_id, created_at',
    )
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) throw alreadyEnded(current.id, 'answered or closed')
  const closed = toQuestion(data as QuestionRow)
  await emitQuestionEvent({
    type: 'company_question.closed',
    payload: {
      questionId: closed.question_id,
      status: 'closed',
      closeReason: reason,
      answeredVia: closed.answered_via,
      answeredAt: closed.answered_at,
      userId: input.userId,
      companyId: input.companyId,
    },
  })
  return closed
}
