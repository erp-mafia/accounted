/**
 * The page's record of approvals that did not go through
 * (approval-results.ts): the latest answer per proposal, read only while the
 * proposal still waits, and gone once an approval succeeds.
 */
import { describe, expect, it } from 'vitest'
import {
  NO_APPROVAL_RESULTS,
  clearFailure,
  failedIds,
  failureKindOf,
  failureOf,
  parseStoredResults,
  recordFailure,
  recordFailures,
} from '../approval-results'

const refused = { kind: 'refused', message: 'Kontot 5611 är inaktivt.' } as const
const network = { kind: 'network', message: 'Begäran nådde inte servern. Försök igen.' } as const

describe('approval results', () => {
  it('tells a request that never got an answer from an answer that said no', () => {
    expect(failureKindOf(new TypeError('Failed to fetch'))).toBe('network')
    expect(failureKindOf(new Error('Kontot 5611 är inaktivt.'))).toBe('refused')
    expect(failureKindOf('x')).toBe('refused')
  })

  it('keeps the latest answer per proposal and never changes the map it was given', () => {
    const first = recordFailure(NO_APPROVAL_RESULTS, 'a', network)
    const second = recordFailure(first, 'a', refused)
    expect(NO_APPROVAL_RESULTS).toEqual({})
    expect(first).toEqual({ a: network })
    expect(second).toEqual({ a: refused })
  })

  it('records the rows a bulk approval left undone in one step', () => {
    const results = recordFailures({ a: network }, [
      { id: 'b', failure: refused },
      { id: 'c', failure: { ...refused, fixCode: 'INVOICE_NUMBER_SERIES_BEHIND' } },
    ])
    expect(Object.keys(results)).toEqual(['a', 'b', 'c'])
    expect(results.c.fixCode).toBe('INVOICE_NUMBER_SERIES_BEHIND')
    const same = { a: network }
    expect(recordFailures(same, [])).toBe(same)
  })

  it('clears a proposal whose approval went through, and returns the same map when there was nothing to clear', () => {
    const results = { a: refused, b: network }
    expect(clearFailure(results, 'a')).toEqual({ b: network })
    expect(clearFailure(results, 'zz')).toBe(results)
  })

  it('reads a failure only while the proposal waits: not while it is on its way again, not once it has left', () => {
    const results = { a: refused, b: network }
    const waiting = new Set(['a'])
    expect(failureOf(results, 'a', waiting)).toBe(refused)
    expect(failureOf(results, 'b', waiting)).toBeNull()
    expect(failureOf(results, null, waiting)).toBeNull()
    expect([...failedIds(results, waiting)]).toEqual(['a'])
    expect(failedIds(results, new Set()).size).toBe(0)
  })

  it('reads back what the tab kept, and reads anything else as no failures', () => {
    const kept = { a: refused, b: { ...network, fixCode: 'X' } }
    expect(parseStoredResults(JSON.stringify(kept))).toEqual(kept)
    expect(parseStoredResults(null)).toEqual({})
    expect(parseStoredResults('not json')).toEqual({})
    expect(parseStoredResults('[1]')).toEqual({})
    expect(parseStoredResults(JSON.stringify({ a: { kind: 'other', message: 'x' }, b: { kind: 'refused' }, c: null }))).toEqual({})
  })
})
