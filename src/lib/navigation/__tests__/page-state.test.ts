import { describe, expect, it } from 'vitest'
import { decodePageState } from '../page-state'

describe('view state storage', () => {
  it('restores collapsed account sets and filter choices', () => {
    expect(decodePageState('["1630","1930"]', new Set<string>())).toEqual(new Set(['1630', '1930']))
    expect(decodePageState('false', true)).toBe(false)
    expect(decodePageState('"1930"', '')).toBe('1930')
    expect(decodePageState('{"fromDate":"2026-01-01"}', {})).toEqual({ fromDate: '2026-01-01' })
  })
  it('falls back on missing, malformed or incompatible storage', () => {
    for (const raw of [null, '{', 'null', '[]', 'false']) expect(decodePageState(raw, '')).toBe('')
    expect(decodePageState('{}', new Set<string>())).toEqual(new Set())
    expect(decodePageState('null', {})).toEqual({})
  })
  it('restores numeric pagination and rejects incompatible saved values', () => {
    expect(decodePageState('300', 100)).toBe(300)
    expect(decodePageState('"x"', 100)).toBe(100)
  })
  it('preserves cleared and selected nullable dimension filters', () => {
    expect(decodePageState('null', null)).toBeNull()
    expect(decodePageState('{"dimNo":"6","code":"P1"}', null)).toEqual({ dimNo: '6', code: 'P1' })
    expect(decodePageState('"invalid"', null)).toBeNull()
  })
})
