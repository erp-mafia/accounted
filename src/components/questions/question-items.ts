/**
 * The question list's page state, pure: what a block shows after an answer
 * or a close, read off what the routes answer.
 */
import type { AppQuestion } from '@/lib/questions/app-answer'
import type { EvidenceLine } from '@/lib/questions/evidence-lines'

/** The two ways the page closes a question without an answer. */
export type AppCloseChoice = 'dont_know' | 'not_relevant'

/**
 * How a question ended: on this page, with the saved fact or the reason it
 * was closed; or closed as settled before the page was read, with the note
 * and the records its close named.
 */
export type EndedState =
  | { kind: 'answered'; fact: string }
  | { kind: 'closed'; reason: AppCloseChoice }
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

/** A question closed as settled comes in ended; every other one is open. */
export function listItems(questions: readonly AppQuestion[]): QuestionItem[] {
  return questions.map((question) => ({
    question,
    ended: question.settled ? { kind: 'settled', note: question.settled.close_note, evidence: question.settled.close_evidence } : null,
    busy: false,
    error: null,
  }))
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
