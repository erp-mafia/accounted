import type { AppQuestion } from '@/lib/questions/app-answer'

/** What the walk shows of a question. */
export type WalkQuestion = Pick<AppQuestion, 'question_id' | 'question' | 'why' | 'options'>

/**
 * The questions Hem's walk shows: the open ones filed after the time this
 * person last went through the walk for the company (all of them when there
 * is none), in the order they were listed.
 */
export function walkQuestions(questions: readonly AppQuestion[], passedAt: string | null | undefined): WalkQuestion[] {
  const passed = passedAt ? Date.parse(passedAt) : Number.NaN
  return questions
    .filter((question) => !question.answered && !question.settled)
    .filter((question) => {
      if (Number.isNaN(passed)) return true
      const filed = Date.parse(question.asked_at)
      return !Number.isNaN(filed) && filed > passed
    })
    .map(({ question_id, question, why, options }) => ({ question_id, question, why, options }))
}

export interface WalkState {
  /** The question ids the walk started with, in order. */
  order: string[]
  /** The place in `order` the walk is at; `order.length` when it is finished. */
  index: number
  /** The sentence each answered question saved, by question id. */
  answered: Record<string, string>
  /** The ids passed with "Inte nu". */
  passed: string[]
  /** The latest answer, while it can be undone. */
  last: { id: string; fact: string } | null
}

export type WalkAction =
  | { type: 'answered'; id: string; fact: string }
  | { type: 'passed'; id: string }
  | { type: 'undone'; id: string }

export function startWalk(order: readonly string[]): WalkState {
  return { order: [...order], index: 0, answered: {}, passed: [], last: null }
}

/** The id of the question on screen; null when the walk is finished. */
export function currentQuestionId(state: WalkState): string | null {
  return state.order[state.index] ?? null
}

export function isWalkFinished(state: WalkState): boolean {
  return state.index >= state.order.length
}

/** The current place as "n of total", n counted from one and never past the total. */
export function walkPosition(state: WalkState): { position: number; total: number } {
  return { position: Math.min(state.index + 1, state.order.length), total: state.order.length }
}

/** Moves the walk on for an answer or a pass, and back for an undo. Anything not on the walk's current step is ignored. */
export function walkReduce(state: WalkState, action: WalkAction): WalkState {
  if (action.type === 'undone') {
    const at = state.order.indexOf(action.id)
    if (at < 0 || !(action.id in state.answered)) return state
    const answered = { ...state.answered }
    delete answered[action.id]
    return { ...state, index: at, answered, last: null }
  }
  if (currentQuestionId(state) !== action.id) return state
  if (action.type === 'answered') {
    return {
      ...state,
      index: state.index + 1,
      answered: { ...state.answered, [action.id]: action.fact },
      passed: state.passed.filter((id) => id !== action.id),
      last: { id: action.id, fact: action.fact },
    }
  }
  return {
    ...state,
    index: state.index + 1,
    passed: state.passed.includes(action.id) ? state.passed : [...state.passed, action.id],
    last: state.last,
  }
}
