/**
 * The question list's page state, pure: what a block shows after an answer
 * or a close, read off what the routes answer.
 */
import type { AppQuestion } from '@/lib/questions/app-answer'

/** The two ways the page closes a question without an answer. */
export type AppCloseChoice = 'dont_know' | 'not_relevant'

/** How a question ended on this page: the saved fact, or the reason it was closed. */
export type EndedState = { kind: 'answered'; fact: string } | { kind: 'closed'; reason: AppCloseChoice }

export interface QuestionItem {
  question: AppQuestion
  /** Null while the question is open. */
  ended: EndedState | null
  /** A write for this question is on its way. */
  busy: boolean
  /** Why the last write did not go through, in the reader's language. */
  error: string | null
}

export function listItems(questions: readonly AppQuestion[]): QuestionItem[] {
  return questions.map((question) => ({ question, ended: null, busy: false, error: null }))
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
