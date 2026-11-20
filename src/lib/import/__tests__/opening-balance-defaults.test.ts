/**
 * Issue #1882: the Ingående balanser voucher was hardcoded to series A and
 * created BEFORE the file's vouchers, so it consumed the A series' next
 * number and shifted every A voucher one number higher than in the source
 * system. It must book in a caller-chosen series, defaulting to one the
 * file's own vouchers do not use.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_OPENING_BALANCE_SERIES,
  defaultOpeningBalanceSeries,
  defaultImportOpeningBalancesOn,
} from '../opening-balance-defaults'

describe('opening-balance defaults helpers', () => {
  it('defaults to M and never A', () => {
    expect(DEFAULT_OPENING_BALANCE_SERIES).toBe('M')
    expect(defaultOpeningBalanceSeries([])).toBe('M')
    expect(defaultOpeningBalanceSeries(['A', 'B', 'F'])).toBe('M')
  })

  it('avoids series the file already uses', () => {
    expect(defaultOpeningBalanceSeries(['A', 'M'])).toBe('O')
    expect(defaultOpeningBalanceSeries(['m', ' o '])).toBe('P')
  })

  it('falls back to M when every candidate is taken', () => {
    const all = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    expect(defaultOpeningBalanceSeries(all)).toBe('M')
  })

  it('IB toggle defaults on only for a first import with IB in the file', () => {
    expect(
      defaultImportOpeningBalancesOn({ hasOpeningBalances: true, existingIbEntryCount: 0 })
    ).toBe(true)
    expect(
      defaultImportOpeningBalancesOn({ hasOpeningBalances: true, existingIbEntryCount: 1 })
    ).toBe(false)
    expect(
      defaultImportOpeningBalancesOn({ hasOpeningBalances: false, existingIbEntryCount: 0 })
    ).toBe(false)
  })
})
