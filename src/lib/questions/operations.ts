/**
 * The staged operations a question's answer led to
 * (company_question_operations): linking one to its question, and reading
 * the operations of a list of questions.
 *
 * What a link is held to, in this order:
 *   1. The question list is switched on for the company.
 *   2. The question is the company's, and is answered or closed as settled.
 *   3. The operation is the company's, and the caller staged it: the
 *      operation names the caller's credential as its stager
 *      (pending_operations.actor_id) and the person the caller acts for
 *      (user_id), as a withdrawal reads ownership
 *      (lib/pending-operations/withdraw.ts).
 *   4. The question holds fewer than QUESTION_LIMITS.maxOperations
 *      operations.
 * A pair that is already linked is answered as linked: nothing is written
 * and no event is emitted. A new link emits company_question.prepared.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { badArgument, codedRefusal } from '@/lib/errors/refusal'
import { isUuid } from '@/lib/invariants/uuid'
import { operationNumberOf } from '@/lib/pending-operations/operation-number'
import { readWithOperationNumber } from '@/lib/pending-operations/operation-number-read'
import { emitQuestionEvent } from './events'
import { assertCompanyQuestionsOn, readQuestionRow } from './rows'
import { QUESTION_LIMITS } from './types'

export interface LinkQuestionOperationInput {
  companyId: string
  questionId: unknown
  operationId: unknown
  /** The person the caller acts for. */
  userId: string
  /**
   * The caller's credential (the API key or the connection), as
   * pending_operations.actor_id names a stager. A caller without one staged
   * nothing.
   */
  actorId: string | null
}

export interface QuestionOperationLink {
  question_id: string
  operation_id: string
  status: 'linked'
}

function idOf(field: 'question_id' | 'operation_id', value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw badArgument(field, `${field} is required`)
  return id
}

/** No operation with that id in the company: a missing one and another company's read the same. */
function operationNotFound(operationId: string): Error {
  return codedRefusal('NOT_FOUND', `No pending operation ${operationId} in this company.`)
}

/** Whether the write failed on the unique pair: the same link was written between the read and the insert. */
function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === '23505'
}

/**
 * Links a staged operation to the question whose answer it was staged
 * because of, and returns the pair. Refuses, writing nothing, when a check
 * in the file header fails.
 */
export async function linkQuestionOperation(
  supabase: SupabaseClient,
  input: LinkQuestionOperationInput,
): Promise<QuestionOperationLink> {
  const { companyId } = input
  assertCompanyQuestionsOn(companyId)
  const questionId = idOf('question_id', input.questionId)
  const operationId = idOf('operation_id', input.operationId)

  const question = await readQuestionRow(supabase, companyId, questionId)
  const linkable = question.status === 'answered' || (question.status === 'closed' && question.close_reason === 'settled')
  if (!linkable) {
    const stands = question.status === 'closed' ? `closed as ${question.close_reason ?? 'unknown'}` : question.status
    throw codedRefusal(
      'COMPANY_QUESTION_NOT_ANSWERED',
      `Question ${question.id} is ${stands}; an operation is linked to a question that is answered, or closed as settled.`,
    )
  }

  if (!isUuid(operationId)) throw operationNotFound(operationId)
  const { data: staged, error: stagedError } = await supabase
    .from('pending_operations')
    .select('id, user_id, actor_id')
    .eq('id', operationId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (stagedError) throw dbError(stagedError)
  const operation = staged as { id: string; user_id: string | null; actor_id: string | null } | null
  if (!operation) throw operationNotFound(operationId)
  if (!input.actorId || operation.actor_id !== input.actorId || operation.user_id !== input.userId) {
    throw codedRefusal(
      'FORBIDDEN',
      `Operation ${operation.id} was not staged by this connection, so it cannot link it to a question.`,
    )
  }

  const linked: QuestionOperationLink = { question_id: question.id, operation_id: operation.id, status: 'linked' }

  const { data: links, error: linksError } = await supabase
    .from('company_question_operations')
    .select('operation_id')
    .eq('company_id', companyId)
    .eq('question_id', question.id)
  if (linksError) throw dbError(linksError)
  const held = ((links ?? []) as Array<{ operation_id: string }>).map((link) => link.operation_id)
  if (held.includes(operation.id)) return linked
  if (held.length >= QUESTION_LIMITS.maxOperations) {
    throw codedRefusal(
      'COMPANY_QUESTION_OPERATION_LIMIT',
      `Question ${question.id} has ${held.length} linked operations; at most ${QUESTION_LIMITS.maxOperations}.`,
    )
  }

  const { error: insertError } = await supabase
    .from('company_question_operations')
    .insert({ company_id: companyId, question_id: question.id, operation_id: operation.id })
  if (insertError) {
    // Two links of the same pair at once: the unique pair let one through.
    if (isUniqueViolation(insertError)) return linked
    throw dbError(insertError)
  }

  await emitQuestionEvent({
    type: 'company_question.prepared',
    payload: { questionId: question.id, operationId: operation.id, userId: input.userId, companyId },
  })
  return linked
}

/** A staged operation as a question's list shows it. */
export interface QuestionOperation {
  operation_id: string
  /** The operation's number in its company; null on one that has none. */
  operation_number: number | null
  title: string
  status: string
  /** On a committed operation: the verifikat it posted, when its result names one. */
  journal_entry_id: string | null
}

interface StagedRow {
  id: string
  operation_number?: number | null
  title: string | null
  status: string
  result_data: unknown
}

function postedEntryOf(row: StagedRow): string | null {
  if (row.status !== 'committed') return null
  const result = row.result_data
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
  const id = (result as Record<string, unknown>).journal_entry_id
  return typeof id === 'string' && isUuid(id) ? id : null
}

/**
 * The operations linked to each of the questions, in the order they were
 * linked, by question id. A question without any has no entry.
 *
 * Both reads go through `supabase` and filter company_id, so a reader gets
 * the operations their own access to pending_operations gives them: a link
 * whose operation the reader cannot read is left out, id and all.
 */
export async function questionOperations(
  supabase: SupabaseClient,
  companyId: string,
  questionIds: readonly string[],
): Promise<Map<string, QuestionOperation[]>> {
  const byQuestion = new Map<string, QuestionOperation[]>()
  const ids = [...new Set(questionIds)]
  if (ids.length === 0) return byQuestion

  const { data: linkRows, error: linksError } = await supabase
    .from('company_question_operations')
    .select('question_id, operation_id, created_at')
    .eq('company_id', companyId)
    .in('question_id', ids)
    .order('created_at', { ascending: true })
    .order('operation_id', { ascending: true })
  if (linksError) throw dbError(linksError)
  const links = (linkRows ?? []) as Array<{ question_id: string; operation_id: string }>
  if (links.length === 0) return byQuestion

  const operationIds = [...new Set(links.map((link) => link.operation_id))]
  // operation_number: read without it while the column is not there yet.
  const { data: stagedRows, error: stagedError } = await readWithOperationNumber((withOperationNumber) => {
    const numbered = () => supabase.from('pending_operations').select('id, operation_number, title, status, result_data')
    const query = withOperationNumber
      ? numbered()
      : (supabase.from('pending_operations').select('id, title, status, result_data') as unknown as ReturnType<typeof numbered>)
    return query.eq('company_id', companyId).in('id', operationIds)
  })
  if (stagedError) throw dbError(stagedError)
  const staged = new Map(((stagedRows ?? []) as StagedRow[]).map((row) => [row.id, row]))

  for (const link of links) {
    const row = staged.get(link.operation_id)
    if (!row) continue
    const operations = byQuestion.get(link.question_id) ?? []
    operations.push({
      operation_id: row.id,
      operation_number: operationNumberOf(row),
      title: typeof row.title === 'string' ? row.title : '',
      status: row.status,
      journal_entry_id: postedEntryOf(row),
    })
    byQuestion.set(link.question_id, operations)
  }
  return byQuestion
}
