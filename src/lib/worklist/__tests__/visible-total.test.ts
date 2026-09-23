import { describe, it, expect } from 'vitest'
import { visibleWorklistTotal, visibleWorklistTotalFrom } from '../visible-total'
import type { WorklistCounts } from '../types'

describe('visibleWorklistTotal', () => {
  it('subtracts inbox documents for non-payers so the count matches the hidden row', () => {
    expect(visibleWorklistTotal({ total: 5, inboxDocumentCount: 3, hasAi: false })).toBe(2)
  })

  it('keeps inbox documents for payers (the row is shown)', () => {
    expect(visibleWorklistTotal({ total: 5, inboxDocumentCount: 3, hasAi: true })).toBe(5)
  })

  it('adds dashboard-only extras (expiring bank connections)', () => {
    expect(visibleWorklistTotal({ total: 5, inboxDocumentCount: 3, hasAi: false, extra: 2 })).toBe(4)
  })

  it('clamps to 0 rather than rendering a negative count on a count skew', () => {
    expect(visibleWorklistTotal({ total: 1, inboxDocumentCount: 3, hasAi: false })).toBe(0)
  })

  it('from() reads total + inbox_document off the worklist object', () => {
    const worklist = { total: 4, counts: { inbox_document: 1 } } as unknown as WorklistCounts
    expect(visibleWorklistTotalFrom(worklist, false, 1)).toBe(4) // 4 + 1 - 1
    expect(visibleWorklistTotalFrom(worklist, true, 1)).toBe(5) // 4 + 1 - 0
  })
})
