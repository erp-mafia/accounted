import { describe, expect, it } from 'vitest'
import type { AppQuestion } from '@/lib/questions/app-answer'
import {
  currentQuestionId,
  isWalkFinished,
  startWalk,
  walkPosition,
  walkQuestions,
  walkReduce,
} from '../question-first'

function question(id: string, askedAt: string, extra: Partial<AppQuestion> = {}): AppQuestion {
  return {
    question_id: id,
    question: `Question ${id}?`,
    why: null,
    options: [{ id: 'yes', label: 'Yes' }],
    evidence: [],
    asked_at: askedAt,
    ...extra,
  }
}

describe('walkQuestions', () => {
  const list = [
    question('a', '2026-11-20T10:00:00.000Z'),
    question('b', '2026-11-22T10:00:00.000Z'),
    question('c', '2026-11-24T10:00:00.000Z'),
  ]

  it('keeps every open question, in the listed order, when nothing was passed', () => {
    expect(walkQuestions(list, null).map((q) => q.question_id)).toEqual(['a', 'b', 'c'])
    expect(walkQuestions(list, undefined)).toHaveLength(3)
  })

  it('keeps only the questions filed after the passed time', () => {
    expect(walkQuestions(list, '2026-11-22T10:00:00.000Z').map((q) => q.question_id)).toEqual(['c'])
    expect(walkQuestions(list, '2026-11-21T00:00:00.000Z').map((q) => q.question_id)).toEqual(['b', 'c'])
  })

  it('drops answered and settled questions', () => {
    const ended = [
      question('a', '2026-11-20T10:00:00.000Z', { answered: { answer: 'Yes', answered_at: null } }),
      question('b', '2026-11-22T10:00:00.000Z', { settled: { close_note: null, close_evidence: [], closed_at: null } }),
      question('c', '2026-11-24T10:00:00.000Z'),
    ]
    expect(walkQuestions(ended, null).map((q) => q.question_id)).toEqual(['c'])
  })

  it('shows all questions when the passed time is not a timestamp', () => {
    expect(walkQuestions(list, 'nonsense')).toHaveLength(3)
  })

  it('hands on only what the walk renders', () => {
    expect(Object.keys(walkQuestions(list, null)[0]).sort()).toEqual(['options', 'question', 'question_id', 'why'])
  })
})

describe('walkReduce', () => {
  it('starts on the first question', () => {
    const state = startWalk(['a', 'b'])
    expect(currentQuestionId(state)).toBe('a')
    expect(walkPosition(state)).toEqual({ position: 1, total: 2 })
    expect(isWalkFinished(state)).toBe(false)
  })

  it('an answer saves the sentence and moves on', () => {
    const state = walkReduce(startWalk(['a', 'b']), { type: 'answered', id: 'a', fact: 'Saved a.' })
    expect(currentQuestionId(state)).toBe('b')
    expect(state.answered).toEqual({ a: 'Saved a.' })
    expect(state.last).toEqual({ id: 'a', fact: 'Saved a.' })
    expect(walkPosition(state)).toEqual({ position: 2, total: 2 })
  })

  it('"Inte nu" moves on and writes nothing', () => {
    const state = walkReduce(startWalk(['a', 'b']), { type: 'passed', id: 'a' })
    expect(currentQuestionId(state)).toBe('b')
    expect(state.passed).toEqual(['a'])
    expect(state.answered).toEqual({})
    expect(state.last).toBeNull()
  })

  it('a pass keeps the line of the earlier answer', () => {
    let state = walkReduce(startWalk(['a', 'b', 'c']), { type: 'answered', id: 'a', fact: 'Saved a.' })
    state = walkReduce(state, { type: 'passed', id: 'b' })
    expect(state.last).toEqual({ id: 'a', fact: 'Saved a.' })
  })

  it('an undo returns to the answered question and clears its answer', () => {
    let state = walkReduce(startWalk(['a', 'b']), { type: 'answered', id: 'a', fact: 'Saved a.' })
    state = walkReduce(state, { type: 'undone', id: 'a' })
    expect(currentQuestionId(state)).toBe('a')
    expect(state.answered).toEqual({})
    expect(state.last).toBeNull()
  })

  it('an undo of a question that was not answered changes nothing', () => {
    const state = startWalk(['a', 'b'])
    expect(walkReduce(state, { type: 'undone', id: 'a' })).toBe(state)
    expect(walkReduce(state, { type: 'undone', id: 'zzz' })).toBe(state)
  })

  it('ignores an answer for a question that is not on screen', () => {
    const state = startWalk(['a', 'b'])
    expect(walkReduce(state, { type: 'answered', id: 'b', fact: 'x' })).toBe(state)
    expect(walkReduce(state, { type: 'passed', id: 'b' })).toBe(state)
  })

  it('is finished when every shown question is answered or passed', () => {
    let state = startWalk(['a', 'b'])
    state = walkReduce(state, { type: 'answered', id: 'a', fact: 'Saved a.' })
    expect(isWalkFinished(state)).toBe(false)
    state = walkReduce(state, { type: 'passed', id: 'b' })
    expect(isWalkFinished(state)).toBe(true)
    expect(currentQuestionId(state)).toBeNull()
    expect(walkPosition(state)).toEqual({ position: 2, total: 2 })
  })

  it('an undo after the last answer reopens the walk', () => {
    let state = walkReduce(startWalk(['a']), { type: 'answered', id: 'a', fact: 'Saved a.' })
    expect(isWalkFinished(state)).toBe(true)
    state = walkReduce(state, { type: 'undone', id: 'a' })
    expect(isWalkFinished(state)).toBe(false)
    expect(currentQuestionId(state)).toBe('a')
  })

  it('an empty walk is finished', () => {
    expect(isWalkFinished(startWalk([]))).toBe(true)
  })
})
