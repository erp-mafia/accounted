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

describe('a question closed as settled in the page state', () => {
  const line = {
    kind: 'transaction' as const,
    id: '10000000-0000-4000-8000-000000000001',
    found: true,
    date: '2026-11-03',
    label: 'Leverantören AB',
    detail: null,
    amount: -4990,
    currency: 'SEK',
    href: '/transactions?highlight=10000000-0000-4000-8000-000000000001',
  }
  const settled: AppQuestion = {
    ...question,
    question_id: 'e0000000-0000-4000-8000-000000000002',
    settled: { close_note: 'Betalningen är bokförd mot fakturan.', close_evidence: [line], closed_at: '2026-11-20T09:00:00.000Z' },
  }

  it('comes in ended, with the note and the records of its close, after the open ones as listed', () => {
    expect(listItems([question, settled])).toEqual([
      { question, ended: null, busy: false, error: null },
      {
        question: settled,
        ended: { kind: 'settled', note: 'Betalningen är bokförd mot fakturan.', evidence: [line] },
        busy: false,
        error: null,
      },
    ])
  })

  it('comes in ended with nothing more when its close said nothing', () => {
    const bare: AppQuestion = { ...settled, settled: { close_note: null, close_evidence: [], closed_at: null } }
    expect(listItems([bare])[0].ended).toEqual({ kind: 'settled', note: null, evidence: [] })
  })
})

