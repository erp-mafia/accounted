import { describe, it, expect } from 'vitest'
import { syncSummary } from '../lib/settings-actions'

describe('syncSummary', () => {
  it('maps an unreadable body to unknown', () => {
    expect(syncSummary(null)).toEqual({ reason: 'unknown' })
    expect(syncSummary({})).toEqual({ reason: 'unknown' })
    expect(syncSummary({ transactions: {} })).toEqual({ reason: 'unknown' })
  })

  it('reports revoked before anything else', () => {
    expect(syncSummary({ transactions: { revoked: true, fetched: 5 } })).toEqual({
      reason: 'revoked',
    })
  })

  it('reports a deadline-truncated run as partial, never as complete', () => {
    expect(
      syncSummary({ transactions: { deadlineReached: true, fetched: 120, inserted: 80 } }),
    ).toEqual({ reason: 'partial', values: { fetched: 120, imported: 80, errors: 0 } })
    // Even a zero-fetch truncated run is partial, not "empty": the window was
    // not exhausted, so claiming the store had nothing would be false.
    expect(
      syncSummary({ transactions: { deadlineReached: true, fetched: 0, inserted: 0 } }),
    ).toEqual({ reason: 'partial', values: { fetched: 0, imported: 0, errors: 0 } })
  })

  it('a truncated run with row errors keeps both facts', () => {
    expect(
      syncSummary({
        transactions: { deadlineReached: true, fetched: 50, inserted: 40, errors: 3 },
      }),
    ).toEqual({ reason: 'partial', values: { fetched: 50, imported: 40, errors: 3 } })
  })

  it('distinguishes empty, errors and feed outcomes', () => {
    expect(syncSummary({ transactions: { fetched: 0 } })).toEqual({ reason: 'empty' })
    expect(
      syncSummary({ transactions: { fetched: 3, inserted: 2, errors: 1 } }),
    ).toEqual({ reason: 'errors', values: { fetched: 3, imported: 2, errors: 1 } })
    expect(syncSummary({ transactions: { fetched: 3, inserted: 3 } })).toEqual({
      reason: 'feed',
      values: { fetched: 3, imported: 3 },
    })
  })
})
