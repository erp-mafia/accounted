/**
 * The question list's page state, pure: what a block shows after an answer
 * or a close, read off what the routes answer, and how the staged operations
 * linked to a question read.
 */
import type { AppOperation, AppQuestion } from '@/lib/questions/app-answer'
import type { EvidenceLine } from '@/lib/questions/evidence-lines'

/** The two ways the page closes a question without an answer. */
export type AppCloseChoice = 'dont_know' | 'not_relevant'

/**
 * How a question ended: on this page, with the saved fact or the reason it
 * was closed; answered before the page was read, with the answer as the
 * person gave it; or closed as settled before the page was read, with the
 * note and the records its close named.
 */
export type EndedState =
  | { kind: 'answered'; fact: string }
  | { kind: 'closed'; reason: AppCloseChoice }
  | { kind: 'answered_earlier'; answer: string | null }
  | { kind: 'settled'; note: string | null; evidence: EvidenceLine[] }

export interface QuestionItem {
  question: AppQuestion
  /** Null while the question is open. */
  ended: EndedState | null
  /** A write for this question is on its way. */
  busy: boolean
  /** Why the last write did not go through, in the reader's language. */
  error: string | null
}

function endedOf(question: AppQuestion): EndedState | null {
  if (question.settled) return { kind: 'settled', note: question.settled.close_note, evidence: question.settled.close_evidence }
  if (question.answered) return { kind: 'answered_earlier', answer: question.answered.answer }
  return null
}

/** An answered question and one closed as settled come in ended; every other one is open. */
export function listItems(questions: readonly AppQuestion[]): QuestionItem[] {
  return questions.map((question) => ({ question, ended: endedOf(question), busy: false, error: null }))
}

/**
 * How a linked operation stands, as its line says it: prepared (it waits for
 * approval), booked (it was approved and carried out) or rejected (it was
 * not carried out).
 */
export type OperationLineState = 'prepared' | 'booked' | 'rejected'

/** One line of a question's linked operations. */
export interface OperationLine {
  operation_id: string
  state: OperationLineState
  title: string
  /**
   * Where the line's link opens: the review of a prepared operation, the
   * verifikat of a booked one whose result names it. Null without a link.
   */
  href: string | null
}

/**
 * The line state of a pending operation's status, grouped as the review
 * list groups its tabs: an approval that is running still reads as
 * prepared, and an operation that failed or whose outcome is unknown reads
 * with the rejected ones. Null for a status this page does not know.
 */
function lineStateOf(status: string): OperationLineState | null {
  switch (status) {
    case 'pending':
    case 'committing':
      return 'prepared'
    case 'committed':
      return 'booked'
    case 'rejected':
    case 'failed_partial':
    case 'unknown':
      return 'rejected'
    default:
      return null
  }
}

/** The lines of a question's linked operations, in the order they were linked. */
export function operationLines(operations: readonly AppOperation[] | undefined): OperationLine[] {
  return (operations ?? []).flatMap((operation) => {
    const state = lineStateOf(operation.status)
    if (!state) return []
    const href =
      state === 'prepared'
        ? `/pending/${operation.operation_id}`
        : state === 'booked' && operation.journal_entry_id
          ? `/bookkeeping/${operation.journal_entry_id}`
          : null
    return [{ operation_id: operation.operation_id, state, title: operation.title, href }]
  })
}

/** The block after an answer: the sentence the answer route says it saved. */
export function answeredState(data: unknown): EndedState {
  const fact = typeof data === 'object' && data !== null && 'fact' in data && typeof data.fact === 'string' ? data.fact : ''
  return { kind: 'answered', fact }
}

export function closedState(reason: AppCloseChoice): EndedState {
  return { kind: 'closed', reason }
}

/** The body of an answer in the person's own words; null while there is nothing to send. */
export function ownWordsBody(text: string): { text: string } | null {
  const trimmed = text.trim()
  return trimmed ? { text: trimmed } : null
}
