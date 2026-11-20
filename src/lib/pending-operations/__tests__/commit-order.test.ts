import { describe, expect, it } from 'vitest'
import { oldestStagedFirst } from '../commit-order'

const rows = (entries: Array<[string, string | null | undefined]>) =>
  new Map(entries.map(([id, created_at]) => [id, { created_at }]))

describe('oldestStagedFirst', () => {
  it('orders the ids oldest staged first, whatever order they were named in', () => {
    const byId = rows([
      ['pay', '2026-03-02T10:00:03.000000+00:00'],
      ['register', '2026-03-02T10:00:01.000000+00:00'],
      ['book', '2026-03-02T10:00:02.000000+00:00'],
    ])
    expect(oldestStagedFirst(['pay', 'book', 'register'], byId)).toEqual(['register', 'book', 'pay'])
  })

  it('tells apart two proposals staged within the same millisecond', () => {
    const byId = rows([
      ['later', '2026-03-02T10:00:01.000450+00:00'],
      ['earlier', '2026-03-02T10:00:01.000120+00:00'],
    ])
    expect(oldestStagedFirst(['later', 'earlier'], byId)).toEqual(['earlier', 'later'])
  })

  it('reads a whole second as earlier than a fraction of the same second', () => {
    const byId = rows([
      ['fraction', '2026-03-02T10:00:01.5+00:00'],
      ['whole', '2026-03-02T10:00:01+00:00'],
    ])
    expect(oldestStagedFirst(['fraction', 'whole'], byId)).toEqual(['whole', 'fraction'])
  })

  it('keeps the given order for the same instant and puts an id without a row last', () => {
    const byId = rows([
      ['a', '2026-03-02T10:00:01+00:00'],
      ['b', '2026-03-02T10:00:01+00:00'],
      ['old', '2026-03-01T10:00:01+00:00'],
      ['undated', undefined],
    ])
    expect(oldestStagedFirst(['missing', 'b', 'undated', 'a', 'old'], byId)).toEqual([
      'old',
      'b',
      'a',
      'missing',
      'undated',
    ])
  })

  it('does not change the list it was given', () => {
    const ids = ['b', 'a']
    oldestStagedFirst(ids, rows([['a', '2026-01-01T00:00:00+00:00'], ['b', '2026-01-02T00:00:00+00:00']]))
    expect(ids).toEqual(['b', 'a'])
  })
})
