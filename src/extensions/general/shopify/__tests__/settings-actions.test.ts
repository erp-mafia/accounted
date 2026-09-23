import { describe, it, expect } from 'vitest'
import { serverErrorMessage, syncSummary, type ShopifySyncPayload } from '../lib/settings-actions'

describe('syncSummary', () => {
  const base = { fetched: 5, refundsFetched: 1, inserted: 4, updated: 1, unchanged: 0, errors: 0 }

  it('classifies a revoked run before anything else', () => {
    expect(syncSummary({ transactions: { ...base, revoked: true } })).toEqual({
      reason: 'revoked',
    })
  })

  it('classifies a truncated run as partial, keeping the error count', () => {
    expect(
      syncSummary({ transactions: { ...base, errors: 2, deadlineReached: true } }),
    ).toEqual({ reason: 'partial', values: { fetched: 5, imported: 4, errors: 2 } })
  })

  it('classifies an empty window as its own outcome', () => {
    expect(
      syncSummary({ transactions: { ...base, fetched: 0, inserted: 0 } }),
    ).toEqual({ reason: 'empty' })
  })

  it('reports both halves when rows landed and rows failed', () => {
    expect(syncSummary({ transactions: { ...base, errors: 2 } })).toEqual({
      reason: 'errors',
      values: { fetched: 5, imported: 4, errors: 2 },
    })
  })

  it('classifies a clean run as feed', () => {
    expect(syncSummary({ transactions: base })).toEqual({
      reason: 'feed',
      values: { fetched: 5, imported: 4 },
    })
  })

  it('classifies an unreadable body as unknown', () => {
    expect(syncSummary(null)).toEqual({ reason: 'unknown' })
    expect(syncSummary({} as ShopifySyncPayload)).toEqual({ reason: 'unknown' })
    expect(syncSummary({ transactions: {} })).toEqual({ reason: 'unknown' })
  })
})

describe('serverErrorMessage', () => {
  it('prefers route copy over the generic map', () => {
    expect(serverErrorMessage({ error: 'Ingen ansluten Shopify-butik.' }, 404, 'sv')).toBe(
      'Ingen ansluten Shopify-butik.',
    )
  })

  it('prefers the English variant when present and the locale is en', () => {
    expect(
      serverErrorMessage({ error: 'Fel.', error_en: 'An error.' }, 500, 'en'),
    ).toBe('An error.')
  })
})
