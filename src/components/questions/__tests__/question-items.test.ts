import { describe, expect, it } from 'vitest'
import type { AppOperation, AppQuestion } from '@/lib/questions/app-answer'
import { answeredState, closedState, listItems, operationLines, ownWordsBody } from '../question-items'

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

describe('a question answered before the page was read, in the page state', () => {
  const answered: AppQuestion = {
    ...question,
    question_id: 'e0000000-0000-4000-8000-000000000003',
    answered: { answer: 'Årsbetalning', answered_at: '2026-11-22T09:00:00.000Z' },
    operations: [],
  }

  it('comes in ended, with the answer as the person gave it, after the open ones as listed', () => {
    expect(listItems([question, answered])).toEqual([
      { question, ended: null, busy: false, error: null },
      { question: answered, ended: { kind: 'answered_earlier', answer: 'Årsbetalning' }, busy: false, error: null },
    ])
  })

  it('comes in ended without an answer when the question records none', () => {
    const bare: AppQuestion = { ...answered, answered: { answer: null, answered_at: null } }
    expect(listItems([bare])[0].ended).toEqual({ kind: 'answered_earlier', answer: null })
  })
})

describe('the lines of the operations linked to a question', () => {
  const ENTRY = '50000000-0000-4000-8000-000000000001'
  const operation = (n: number, status: string, journalEntryId: string | null = null): AppOperation => ({
    operation_id: `0b000000-0000-4000-8000-00000000000${n}`,
    operation_number: 100 + n,
    title: `Förslag ${n}`,
    status,
    journal_entry_id: journalEntryId,
  })
  const idOf = (n: number) => `0b000000-0000-4000-8000-00000000000${n}`

  it('reads a waiting operation as prepared, with the link to its review', () => {
    expect(operationLines([operation(1, 'pending')])).toEqual([
      { operation_id: idOf(1), state: 'prepared', title: 'Förslag 1', href: `/pending/${idOf(1)}` },
    ])
  })

  it('reads a committed operation as booked, with the link to its verifikat when its result names one', () => {
    expect(operationLines([operation(1, 'committed', ENTRY), operation(2, 'committed')])).toEqual([
      { operation_id: idOf(1), state: 'booked', title: 'Förslag 1', href: `/bookkeeping/${ENTRY}` },
      { operation_id: idOf(2), state: 'booked', title: 'Förslag 2', href: null },
    ])
  })

  it('reads a rejected operation as rejected, without a link', () => {
    expect(operationLines([operation(1, 'rejected', ENTRY)])).toEqual([
      { operation_id: idOf(1), state: 'rejected', title: 'Förslag 1', href: null },
    ])
  })

  it('reads an approval that is running as prepared, and a failed or unknown outcome with the rejected ones', () => {
    expect(operationLines([operation(1, 'committing'), operation(2, 'failed_partial', ENTRY), operation(3, 'unknown')]).map((line) => [line.state, line.href])).toEqual([
      ['prepared', `/pending/${idOf(1)}`],
      ['rejected', null],
      ['rejected', null],
    ])
  })

  it('keeps the order the operations were linked in, and leaves out a status it does not know', () => {
    expect(operationLines([operation(3, 'rejected'), operation(1, 'pending'), operation(2, 'archived')]).map((line) => line.operation_id)).toEqual([idOf(3), idOf(1)])
  })

  it('is empty for a question without operations', () => {
    expect(operationLines([])).toEqual([])
    expect(operationLines(undefined)).toEqual([])
  })
})
