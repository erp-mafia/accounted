/**
 * A company_questions row as the doors hand it out: qualified ids, the
 * stored lists read defensively.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { codedRefusal } from '@/lib/errors/refusal'
import { isCompanyQuestionsEnabled } from '@/lib/env/company-questions-switch'
import { isUuid } from '@/lib/invariants/uuid'
import {
  EVIDENCE_KINDS,
  QUESTION_CLOSE_REASONS,
  QUESTION_STATUSES,
  type CompanyQuestion,
  type EvidenceKind,
  type EvidenceRef,
  type QuestionCloseReason,
  type QuestionOption,
  type QuestionStatus,
} from './types'

export interface QuestionRow {
  id: string
  status: string
  close_reason: string | null
  question: string
  why: string | null
  options: unknown
  evidence: unknown
  actor_label: string | null
  client: string | null
  answer_option: string | null
  answer_text: string | null
  answered_at: string | null
  answered_via: string | null
  fact_id: string | null
  created_at: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionsOf(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === 'string' && typeof entry.label === 'string' ? [{ id: entry.id, label: entry.label }] : [],
  )
}

function evidenceOf(value: unknown): EvidenceRef[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === 'string' && (EVIDENCE_KINDS as readonly unknown[]).includes(entry.kind)
      ? [{ kind: entry.kind as EvidenceKind, id: entry.id }]
      : [],
  )
}

export function toQuestion(row: QuestionRow): CompanyQuestion {
  return {
    question_id: row.id,
    status: (QUESTION_STATUSES as readonly string[]).includes(row.status) ? (row.status as QuestionStatus) : 'open',
    close_reason: (QUESTION_CLOSE_REASONS as readonly unknown[]).includes(row.close_reason) ? (row.close_reason as QuestionCloseReason) : null,
    question: row.question,
    why: row.why,
    options: optionsOf(row.options),
    evidence: evidenceOf(row.evidence),
    asked_by: row.actor_label,
    client: row.client,
    answer_option: row.answer_option,
    answer_text: row.answer_text,
    answered_at: row.answered_at,
    answered_via: row.answered_via,
    fact_id: row.fact_id,
    created_at: row.created_at,
  }
}

/** Refuses with COMPANY_QUESTIONS_OFF unless the list is switched on for the company. */
export function assertCompanyQuestionsOn(companyId: string): void {
  if (!isCompanyQuestionsEnabled(companyId)) {
    throw codedRefusal('COMPANY_QUESTIONS_OFF', 'The question list is not switched on for this company.')
  }
}

/** No question with that id in the company: a missing one and another company's read the same. */
export function questionNotFound(questionId: string): Error {
  return codedRefusal('COMPANY_QUESTION_NOT_FOUND', `No question ${questionId} in this company.`)
}

/** The question's row as it stands in the company, whatever its status. Refuses a missing one; throws when the read fails. */
export async function readQuestionRow(supabase: SupabaseClient, companyId: string, questionId: string): Promise<QuestionRow> {
  if (!isUuid(questionId)) throw questionNotFound(questionId)
  const { data, error } = await supabase
    .from('company_questions')
    .select(
      'id, status, close_reason, question, why, options, evidence, actor_label, client, answer_option, answer_text, answered_at, answered_via, fact_id, created_at',
    )
    .eq('id', questionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) throw questionNotFound(questionId)
  return data as QuestionRow
}
