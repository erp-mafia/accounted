import { describe, it, expect } from 'vitest'
import { syncSummary } from '../lib/settings-actions'

describe('zettle syncSummary', () => {
  it('classifies revoked / empty / feed / errors / partial', () => {
    expect(syncSummary({ transactions: { fetched: 1, revoked: true } }).reason).toBe(
      'revoked',
    )
    expect(syncSummary({ transactions: { fetched: 0, inserted: 0 } }).reason).toBe('empty')
    expect(syncSummary({ transactions: { fetched: 3, inserted: 2 } })).toEqual({
      reason: 'feed',
      values: { fetched: 3, imported: 2, needsReview: 0 },
    })
    expect(syncSummary({ transactions: { fetched: 3, inserted: 1, errors: 2 } })).toEqual({
      reason: 'errors',
      values: { fetched: 3, imported: 1, needsReview: 0, errors: 2 },
    })
    expect(
      syncSummary({
        transactions: { fetched: 5, inserted: 4, errors: 0, deadlineReached: true },
      }),
    ).toEqual({
      reason: 'partial',
      values: { fetched: 5, imported: 4, needsReview: 0, errors: 0 },
    })
  })
})
