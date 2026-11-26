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
import { pendingOperationTaskState } from '@/lib/pending-operations/task-state'
import { ID_READ_CHUNK } from '@/lib/supabase/read-in-slices'
import { chunk } from '@/lib/utils'
import { emitQuestionEvent } from './events'
import { evidenceLines } from './evidence-lines'
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

/**
 * Whether a question takes the operations its answer led to: it is
 * answered, or closed as settled. Only such a question is linked to an
 * operation, and only such a question has a follow-up (questionFollowUp).
 */
export function takesOperations(question: { status: string; close_reason: string | null }): boolean {
  return question.status === 'answered' || (question.status === 'closed' && question.close_reason === 'settled')
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
  if (!takesOperations(question)) {
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

/** The bank row an operation acts on, as the row itself reads. */
export interface QuestionOperationBankRow {
  /** The merchant, or the bank text. */
  label: string | null
  /** The row's amount, signed as the bank states it. */
  amount: number | null
  currency: string | null
}

/** A staged operation as a question's list shows it. */
export interface QuestionOperation {
  operation_id: string
  /** The operation's number in its company; null on one that has none. */
  operation_number: number | null
  /** What approving it does (pending_operations.operation_type). */
  operation_type: string
  title: string
  status: string
  /** On a committed operation: the verifikat it posted, when its result names one. */
  journal_entry_id: string | null
  /** The bank row it names, read from the row; null when it names none or the row is not the company's to read. */
  bank_row: QuestionOperationBankRow | null
  /** The file it attaches, by name, when its preview states one. */
  document_name: string | null
  /** The verifikat it links to, by the label its preview states, when it states one. */
  voucher_label: string | null
}

/**
 * Where the follow-up of an answer stands, read off the operations linked to
 * its question and nothing else:
 *   no_operation       none is linked: nothing was prepared from the answer
 *   awaiting_approval  one waits for approval, or is being carried out
 *   done               none waits, and one was carried out
 *   not_carried_out    every one was rejected, failed or expired
 */
export const QUESTION_FOLLOW_UPS = ['no_operation', 'awaiting_approval', 'done', 'not_carried_out'] as const
export type QuestionFollowUp = (typeof QUESTION_FOLLOW_UPS)[number]

/** The follow-up of an answer, from the statuses of its linked operations, grouped as the task states group them. */
export function questionFollowUp(operations: readonly Pick<QuestionOperation, 'status'>[]): QuestionFollowUp {
  const states = operations.map((operation) => pendingOperationTaskState({ status: operation.status }))
  if (states.length === 0) return 'no_operation'
  if (states.includes('working')) return 'awaiting_approval'
  if (states.includes('completed')) return 'done'
  return 'not_carried_out'
}

/** A pending_operations row as the reads of an operation's line select it. */
export interface StagedRow {
  id: string
  operation_number?: number | null
  operation_type: string | null
  title: string | null
  status: string
  result_data: unknown
  /** params.transaction_id: of the staged input, only the id of the bank row it names. */
  transaction_id: string | null
  /** preview_data.document_file_name. */
  document_name: string | null
  /** preview_data.voucher_label. */
  voucher_label: string | null
}

const stated = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/**
 * The bank rows the operations name, by row id, as a question's own records
 * read a bank row (evidenceLines): the merchant or the bank text, the amount
 * and the currency. A row that is not the company's has no entry.
 */
async function namedBankRows(
  supabase: SupabaseClient,
  companyId: string,
  rows: readonly StagedRow[],
): Promise<Map<string, QuestionOperationBankRow>> {
  const ids = [...new Set(rows.map((row) => row.transaction_id).filter((id): id is string => isUuid(id)))]
  const named = new Map<string, QuestionOperationBankRow>()
  if (ids.length === 0) return named
  const [lines] = await evidenceLines(supabase, companyId, [ids.map((id) => ({ kind: 'transaction' as const, id }))])
  for (const line of lines ?? []) {
    if (line.found) named.set(line.id, { label: line.label, amount: line.amount, currency: line.currency })
  }
  return named
}

function postedEntryOf(row: StagedRow): string | null {
  if (row.status !== 'committed') return null
  const result = row.result_data
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
  const id = (result as Record<string, unknown>).journal_entry_id
  return typeof id === 'string' && isUuid(id) ? id : null
}

/**
 * The rows as the operations a list shows, in the order given: each with
 * what its line is built from (see questionOperations). The bank rows they
 * name are read through `supabase` with the company filter, so a row the
 * reader cannot read is left without its bank row.
 */
export async function operationsOfRows(supabase: SupabaseClient, companyId: string, rows: readonly StagedRow[]): Promise<QuestionOperation[]> {
  const bankRows = await namedBankRows(supabase, companyId, rows)
  return rows.map((row) => ({
    operation_id: row.id,
    operation_number: operationNumberOf(row),
    operation_type: stated(row.operation_type) ?? '',
    title: typeof row.title === 'string' ? row.title : '',
    status: row.status,
    journal_entry_id: postedEntryOf(row),
    bank_row: (isUuid(row.transaction_id) ? bankRows.get(row.transaction_id) : undefined) ?? null,
    document_name: stated(row.document_name),
    voucher_label: stated(row.voucher_label),
  }))
}

/**
 * The operations linked to each of the questions, in the order they were
 * linked, by question id. A question without any has no entry.
 *
 * Each operation comes with what its line on the page is built from: its
 * type, the bank row it names (the id is params.transaction_id; the text,
 * the amount and the currency are read from the row), the file its preview
 * names (preview_data.document_file_name), the verifikat label its preview
 * names (preview_data.voucher_label) and the verifikat its result names.
 * Nothing else of the staged input or the preview is read.
 *
 * Every read goes through `supabase` and filters company_id, so a reader
 * gets the operations their own access to pending_operations gives them: a
 * link whose operation the reader cannot read is left out, id and all.
 */
export async function questionOperations(
  supabase: SupabaseClient,
  companyId: string,
  questionIds: readonly string[],
): Promise<Map<string, QuestionOperation[]>> {
  const byQuestion = new Map<string, QuestionOperation[]>()
  const ids = [...new Set(questionIds)]
  if (ids.length === 0) return byQuestion

  // In slices of ID_READ_CHUNK: the ids travel in the GET query string, which
  // the gateway refuses past its limit, and gnubok_list_questions lists up to
  // 200 questions. A question's links all come in its own slice, in the order
  // they were linked.
  const links: Array<{ question_id: string; operation_id: string }> = []
  for (const slice of chunk(ids, ID_READ_CHUNK)) {
    const { data: linkRows, error: linksError } = await supabase
      .from('company_question_operations')
      .select('question_id, operation_id, created_at')
      .eq('company_id', companyId)
      .in('question_id', slice)
      .order('created_at', { ascending: true })
      .order('operation_id', { ascending: true })
    if (linksError) throw dbError(linksError)
    links.push(...((linkRows ?? []) as Array<{ question_id: string; operation_id: string }>))
  }
  if (links.length === 0) return byQuestion

  const operationIds = [...new Set(links.map((link) => link.operation_id))]
  // Sliced the same way: a question holds up to QUESTION_LIMITS.maxOperations,
  // so 200 questions name up to 1000 operations.
  const rows: StagedRow[] = []
  for (const slice of chunk(operationIds, ID_READ_CHUNK)) {
    // operation_number: read without it while the column is not there yet.
    const { data: stagedRows, error: stagedError } = await readWithOperationNumber((withOperationNumber) => {
      const numbered = () =>
        supabase
          .from('pending_operations')
          .select(
            'id, operation_number, operation_type, title, status, result_data, transaction_id:params->>transaction_id, document_name:preview_data->>document_file_name, voucher_label:preview_data->>voucher_label',
          )
      const query = withOperationNumber
        ? numbered()
        : (supabase
            .from('pending_operations')
            .select(
              'id, operation_type, title, status, result_data, transaction_id:params->>transaction_id, document_name:preview_data->>document_file_name, voucher_label:preview_data->>voucher_label',
            ) as unknown as ReturnType<typeof numbered>)
      return query.eq('company_id', companyId).in('id', slice)
    })
    if (stagedError) throw dbError(stagedError)
    rows.push(...((stagedRows ?? []) as unknown as StagedRow[]))
  }
  const staged = new Map((await operationsOfRows(supabase, companyId, rows)).map((operation) => [operation.operation_id, operation]))

  for (const link of links) {
    const operation = staged.get(link.operation_id)
    if (!operation) continue
    const operations = byQuestion.get(link.question_id) ?? []
    // A copy per link, so a list never shares an operation with another question's.
    operations.push({ ...operation })
    byQuestion.set(link.question_id, operations)
  }
  return byQuestion
}
