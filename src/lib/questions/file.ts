/**
 * Filing a question: the one write that puts a question on a company's list.
 *
 * What it holds a question to, in this order:
 *   1. The text, the options and the evidence references are well formed.
 *   2. Never twice: one question per company and set of records, whatever
 *      became of the earlier one.
 *   3. Every evidence reference names a record of this company.
 *   4. Every money amount written in the question or in why stands on one
 *      of those records.
 *   5. The limits: open questions at once, and questions filed in 24 hours.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { badArgument, codedRefusal, fieldValidationError, type FieldIssue } from '@/lib/errors/refusal'
import { amountsNotAmong } from './amounts'
import { emitQuestionEvent } from './events'
import { resolveEvidence } from './evidence'
import { assertCompanyQuestionsOn, toQuestion, type QuestionRow } from './rows'
import {
  EVIDENCE_KINDS,
  QUESTION_LIMITS,
  type CompanyQuestion,
  type EvidenceKind,
  type EvidenceRef,
  type QuestionActor,
  type QuestionOption,
} from './types'

export interface FileQuestionInput {
  companyId: string
  question: unknown
  why?: unknown
  options?: unknown
  evidence: unknown
  /** The person the question is filed by, or the person the credential acts for. */
  userId: string | null
  actor?: QuestionActor | null
}

const DAY_MS = 24 * 60 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(field: 'question' | 'why', value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw badArgument(field, `${field} is required`)
    return null
  }
  if (typeof value !== 'string') throw badArgument(field, `${field} must be a string`, 'Måste vara text.')
  const text = value.trim()
  if (text.length > QUESTION_LIMITS.maxText) {
    throw badArgument(
      field,
      `${field} is ${text.length} characters; at most ${QUESTION_LIMITS.maxText}`,
      `Högst ${QUESTION_LIMITS.maxText} tecken.`,
    )
  }
  return text
}

function optionsOf(value: unknown): QuestionOption[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw badArgument('options', 'options must be an array', 'Måste vara en lista.')
  if (value.length > QUESTION_LIMITS.maxOptions) {
    throw badArgument(
      'options',
      `${value.length} options; at most ${QUESTION_LIMITS.maxOptions}`,
      `Högst ${QUESTION_LIMITS.maxOptions} svarsalternativ.`,
    )
  }
  const options: QuestionOption[] = []
  value.forEach((entry, index) => {
    const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id.trim() : ''
    const label = isRecord(entry) && typeof entry.label === 'string' ? entry.label.trim() : ''
    if (!id || id.length > QUESTION_LIMITS.maxOptionId) {
      throw badArgument(
        `options.${index}`,
        `options.${index}.id must be 1 to ${QUESTION_LIMITS.maxOptionId} characters`,
        `Alternativets id måste vara 1 till ${QUESTION_LIMITS.maxOptionId} tecken.`,
      )
    }
    if (!label || label.length > QUESTION_LIMITS.maxOptionLabel) {
      throw badArgument(
        `options.${index}`,
        `options.${index}.label must be 1 to ${QUESTION_LIMITS.maxOptionLabel} characters`,
        `Alternativets text måste vara 1 till ${QUESTION_LIMITS.maxOptionLabel} tecken.`,
      )
    }
    if (options.some((option) => option.id === id)) {
      throw badArgument('options', `option id "${id}" is used twice`, 'Två alternativ har samma id.')
    }
    options.push({ id, label })
  })
  return options
}

function evidenceOf(value: unknown): EvidenceRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badArgument('evidence', 'evidence is required: at least one record the question rests on')
  }
  if (value.length > QUESTION_LIMITS.maxEvidence) {
    throw badArgument(
      'evidence',
      `${value.length} evidence references; at most ${QUESTION_LIMITS.maxEvidence}`,
      `Högst ${QUESTION_LIMITS.maxEvidence} underlag.`,
    )
  }
  const refs: EvidenceRef[] = []
  value.forEach((entry, index) => {
    const kind = isRecord(entry) ? entry.kind : undefined
    const rawId = isRecord(entry) && typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!(EVIDENCE_KINDS as readonly unknown[]).includes(kind)) {
      throw badArgument(
        `evidence.${index}`,
        `evidence.${index}.kind must be one of ${EVIDENCE_KINDS.join(', ')}`,
        `Underlagets typ måste vara en av ${EVIDENCE_KINDS.join(', ')}.`,
      )
    }
    if (!rawId) throw badArgument(`evidence.${index}`, `evidence.${index}.id is required`)
    // Ids are stored in lower case; an account number has no case.
    const ref: EvidenceRef = { kind: kind as EvidenceKind, id: rawId.toLowerCase() }
    if (!refs.some((seen) => seen.kind === ref.kind && seen.id === ref.id)) refs.push(ref)
  })
  return refs
}

/** A provenance text within the length its column holds, or null. */
function clip(value: string | null | undefined, max: number): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : null
}

/** sha256 over the sorted `kind:id` references: the same records give the same fingerprint in any order. */
export function evidenceFingerprint(refs: readonly EvidenceRef[]): string {
  const keys = refs.map((ref) => `${ref.kind}:${ref.id}`).sort()
  return createHash('sha256').update(keys.join('\n')).digest('hex')
}

async function existingQuestion(
  supabase: SupabaseClient,
  companyId: string,
  fingerprint: string,
): Promise<{ id: string; status: string } | null> {
  const { data, error } = await supabase
    .from('company_questions')
    .select('id, status')
    .eq('company_id', companyId)
    .eq('fingerprint', fingerprint)
    .maybeSingle()
  if (error) throw dbError(error)
  return (data as { id: string; status: string } | null) ?? null
}

function alreadyAsked(existing: { id: string; status: string }): Error {
  return codedRefusal(
    'COMPANY_QUESTION_ALREADY_ASKED',
    `Already asked: question ${existing.id} (${existing.status}) rests on the same records. A question is put once.`,
  )
}

async function assertWithinLimits(supabase: SupabaseClient, companyId: string): Promise<void> {
  const open = await supabase
    .from('company_questions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'open')
  if (open.error) throw dbError(open.error)
  if ((open.count ?? 0) >= QUESTION_LIMITS.maxOpen) {
    throw codedRefusal(
      'COMPANY_QUESTION_LIMIT_REACHED',
      `${QUESTION_LIMITS.maxOpen} questions are open for this company, which is the limit. File this one when one of them is answered or closed.`,
    )
  }
  const since = new Date(Date.now() - DAY_MS).toISOString()
  const filed = await supabase
    .from('company_questions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .gte('created_at', since)
  if (filed.error) throw dbError(filed.error)
  if ((filed.count ?? 0) >= QUESTION_LIMITS.maxFiledPerDay) {
    throw codedRefusal(
      'COMPANY_QUESTION_LIMIT_REACHED',
      `${QUESTION_LIMITS.maxFiledPerDay} questions were filed for this company in the last 24 hours, which is the limit. File this one later.`,
    )
  }
}

/**
 * Files a question for the company and returns it. Refuses, writing nothing,
 * when any of the checks in the file header fails. A filed question emits
 * company_question.filed.
 */
export async function fileQuestion(supabase: SupabaseClient, input: FileQuestionInput): Promise<CompanyQuestion> {
  assertCompanyQuestionsOn(input.companyId)

  const question = textOf('question', input.question, true) as string
  const why = textOf('why', input.why, false)
  const options = optionsOf(input.options)
  const evidence = evidenceOf(input.evidence)
  const fingerprint = evidenceFingerprint(evidence)

  const existing = await existingQuestion(supabase, input.companyId, fingerprint)
  if (existing) throw alreadyAsked(existing)

  const resolved = await resolveEvidence(supabase, input.companyId, evidence)
  if (resolved.missing.length > 0) {
    const issues: FieldIssue[] = resolved.missing.map((ref) => ({
      field: `evidence.${evidence.findIndex((e) => e.kind === ref.kind && e.id === ref.id)}`,
      en: `no ${ref.kind} ${ref.id} in this company`,
      sv: `Underlaget ${ref.kind} ${ref.id} finns inte i företaget.`,
    }))
    throw fieldValidationError('Evidence not found', issues)
  }

  const notOnEvidence = amountsNotAmong([question, why], resolved.amounts)
  if (notOnEvidence.length > 0) {
    const issues: FieldIssue[] = notOnEvidence.map((amount) => ({
      field: 'question',
      en: `the amount "${amount}" is on none of the evidence records; write amounts as they stand on the records, or cite the record that carries it`,
      sv: `Beloppet "${amount}" finns inte på något av underlagen.`,
    }))
    throw fieldValidationError('Amount not on the evidence', issues)
  }

  await assertWithinLimits(supabase, input.companyId)

  const actor = input.actor ?? null
  const { data, error } = await supabase
    .from('company_questions')
    .insert({
      company_id: input.companyId,
      status: 'open',
      question,
      why,
      options,
      evidence,
      fingerprint,
      created_by_user_id: input.userId,
      actor_type: clip(actor?.type, 40),
      actor_id: clip(actor?.id, 100),
      actor_label: clip(actor?.label, 200),
      client: clip(actor?.client, 100),
    })
    .select(
      'id, status, close_reason, question, why, options, evidence, actor_label, client, answer_option, answer_text, answered_at, answered_via, fact_id, created_at',
    )
    .single()
  if (error) {
    // Two filers at once: the unique fingerprint let one through.
    if ((error as { code?: string }).code === '23505') {
      const winner = await existingQuestion(supabase, input.companyId, fingerprint)
      if (winner) throw alreadyAsked(winner)
    }
    throw dbError(error)
  }
  if (!data) throw new Error('Failed to file the question: no row returned')
  const filed = toQuestion(data as QuestionRow)
  await emitQuestionEvent({
    type: 'company_question.filed',
    payload: {
      questionId: filed.question_id,
      status: 'open',
      createdAt: filed.created_at,
      userId: input.userId,
      companyId: input.companyId,
    },
  })
  return filed
}
