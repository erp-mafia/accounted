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
  standingOpeningBalanceVoucherCount,
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

  describe('replacing an earlier import of the year', () => {
    const replaced = 'import-being-replaced'
    // The year's only IB voucher was booked by the import the user replaces.
    const yearVouchers: { import_batch_id: string | null }[] = [{ import_batch_id: replaced }]
    const defaultOn = (replacingImportId: string | null, vouchers = yearVouchers) =>
      defaultImportOpeningBalancesOn({
        hasOpeningBalances: true,
        existingIbEntryCount: standingOpeningBalanceVoucherCount(vouchers, replacingImportId),
      })

    it('turns the IB toggle on: the replace stornos that voucher before booking', () => {
      expect(standingOpeningBalanceVoucherCount(yearVouchers, replaced)).toBe(0)
      expect(defaultOn(replaced)).toBe(true)
    })

    it('keeps it off when adding to the import instead of replacing it', () => {
      expect(standingOpeningBalanceVoucherCount(yearVouchers, null)).toBe(1)
      expect(defaultOn(null)).toBe(false)
    })

    it('keeps it off when an IB voucher booked by hand or by another import stays', () => {
      expect(defaultOn(replaced, [...yearVouchers, { import_batch_id: null }])).toBe(false)
      expect(defaultOn(replaced, [...yearVouchers, { import_batch_id: 'another-import' }])).toBe(false)
    })
  })
})
