import { describe, expect, it } from 'vitest'
import type { AppQuestion } from '@/lib/questions/app-answer'
import { answeredState, closedState, listItems, ownWordsBody } from '../question-items'

const question: AppQuestion = {
  question_id: 'e0000000-0000-4000-8000-000000000001',
  question: 'Vad har ändrats?',
  why: null,
  options: [],
  evidence: [],
  asked_at: '2026-11-19T08:00:00.000Z',
}

describe('the question list page state', () => {
  it('starts every question open, idle and without an error', () => {
    expect(listItems([question])).toEqual([{ question, ended: null, busy: false, error: null }])
    expect(listItems([])).toEqual([])
  })

  it('shows the sentence the answer route says it saved', () => {
    expect(answeredState({ question_id: question.question_id, fact_id: 'f', fact: 'Vad har ändrats? Svar: Årsbetalning' })).toEqual({
      kind: 'answered',
      fact: 'Vad har ändrats? Svar: Årsbetalning',
    })
    // An answer without the sentence still ends the block.
    for (const data of [undefined, null, {}, { fact: 7 }, 'text']) expect(answeredState(data)).toEqual({ kind: 'answered', fact: '' })
  })

  it('remembers the reason a question was closed with', () => {
    expect(closedState('dont_know')).toEqual({ kind: 'closed', reason: 'dont_know' })
    expect(closedState('not_relevant')).toEqual({ kind: 'closed', reason: 'not_relevant' })
  })

  it('sends an answer in own words trimmed, and nothing for an empty one', () => {
    expect(ownWordsBody('  Vi bytte till årsbetalning. ')).toEqual({ text: 'Vi bytte till årsbetalning.' })
    expect(ownWordsBody('   ')).toBeNull()
    expect(ownWordsBody('')).toBeNull()
  })
})
