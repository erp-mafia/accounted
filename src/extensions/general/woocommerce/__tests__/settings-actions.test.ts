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
    ).toEqual({ reason: 'partial', values: { fetched: 120, imported: 80, unknownCurrency: 0, errors: 0 } })
    // Even a zero-fetch truncated run is partial, not "empty": the window was
    // not exhausted, so claiming the store had nothing would be false.
    expect(
      syncSummary({ transactions: { deadlineReached: true, fetched: 0, inserted: 0 } }),
    ).toEqual({ reason: 'partial', values: { fetched: 0, imported: 0, unknownCurrency: 0, errors: 0 } })
  })

  it('a truncated run with row errors keeps both facts', () => {
    expect(
      syncSummary({
        transactions: { deadlineReached: true, fetched: 50, inserted: 40, errors: 3 },
      }),
    ).toEqual({ reason: 'partial', values: { fetched: 50, imported: 40, unknownCurrency: 0, errors: 3 } })
  })

  it('distinguishes empty, errors and feed outcomes', () => {
    expect(syncSummary({ transactions: { fetched: 0 } })).toEqual({ reason: 'empty' })
    expect(
      syncSummary({ transactions: { fetched: 3, inserted: 2, errors: 1 } }),
    ).toEqual({ reason: 'errors', values: { fetched: 3, imported: 2, unknownCurrency: 0, errors: 1 } })
    expect(syncSummary({ transactions: { fetched: 3, inserted: 3 } })).toEqual({
      reason: 'feed',
      values: { fetched: 3, imported: 3, unknownCurrency: 0 },
    })
  })

  it('carries orders skipped for an unusable currency, apart from errors', () => {
    // Every fetched order skipped: the currency count is what the toast has
    // to explain, and it is not an error that syncing again would fix.
    expect(
      syncSummary({ transactions: { fetched: 12, inserted: 0, unknownCurrency: 12 } }),
    ).toEqual({ reason: 'feed', values: { fetched: 12, imported: 0, unknownCurrency: 12 } })
    expect(
      syncSummary({
        transactions: { deadlineReached: true, fetched: 5, inserted: 3, unknownCurrency: 2 },
      }),
    ).toEqual({
      reason: 'partial',
      values: { fetched: 5, imported: 3, unknownCurrency: 2, errors: 0 },
    })
  })
})
