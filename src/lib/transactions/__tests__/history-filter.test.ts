import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bankRowMatchesHistoryFilter,
  skattekontoRowMatchesHistoryFilter,
} from '../history-filter'

describe('bankRowMatchesHistoryFilter', () => {
  // crm#1612: a migrated bank row the user ignored, never categorised.
  const ignored = { is_business: null, is_ignored: true }
  const business = { is_business: true, is_ignored: false }
  const privateRow = { is_business: false, is_ignored: false }
  const pending = { is_business: null, is_ignored: false }

  it('finds the ignored row under Ignorerade and nothing else there', () => {
    expect(bankRowMatchesHistoryFilter(ignored, 'ignored')).toBe(true)
    expect(bankRowMatchesHistoryFilter(business, 'ignored')).toBe(false)
    expect(bankRowMatchesHistoryFilter(privateRow, 'ignored')).toBe(false)
    expect(bankRowMatchesHistoryFilter(pending, 'ignored')).toBe(false)
  })

  it('keeps every row under Alla', () => {
    for (const row of [ignored, business, privateRow, pending]) {
      expect(bankRowMatchesHistoryFilter(row, 'all')).toBe(true)
    }
  })

  it('keeps an ignored row out of Företag and Privat even if it was categorised', () => {
    expect(bankRowMatchesHistoryFilter({ is_business: true, is_ignored: true }, 'business')).toBe(false)
    expect(bankRowMatchesHistoryFilter({ is_business: false, is_ignored: true }, 'private')).toBe(false)
    expect(bankRowMatchesHistoryFilter(business, 'business')).toBe(true)
    expect(bankRowMatchesHistoryFilter(privateRow, 'private')).toBe(true)
  })
})

describe('skattekontoRowMatchesHistoryFilter', () => {
  it('shows unignored skattekonto rows under Alla only; ignored ones live on Skattekonto', () => {
    expect(skattekontoRowMatchesHistoryFilter({ is_ignored: false }, 'all')).toBe(true)
    expect(skattekontoRowMatchesHistoryFilter({ is_ignored: true }, 'all')).toBe(false)
    expect(skattekontoRowMatchesHistoryFilter({ is_ignored: true }, 'ignored')).toBe(false)
    expect(skattekontoRowMatchesHistoryFilter({ is_ignored: false }, 'ignored')).toBe(false)
    expect(skattekontoRowMatchesHistoryFilter({ is_ignored: false }, 'business')).toBe(false)
    expect(skattekontoRowMatchesHistoryFilter({ is_ignored: true }, 'private')).toBe(false)
  })
})

describe('ignore wayfinding (crm#1612)', () => {
  // Bankavstämning stopped being a menu entry on 2026-10-18 (Konton is the one
  // account list). Text that sends users "under Bankavstämning" or to
  // "Rapporter → Bankavstämning" points at a place they cannot find.
  const root = join(__dirname, '../../../..')
  const files = [
    'src/messages/sv.json',
    'src/messages/en.json',
    'src/app/(dashboard)/transactions/page.tsx',
    'src/components/transactions/MatchVoucherDialog.tsx',
    'src/lib/errors/structured-errors.ts',
  ]
  const stale = [
    /under Bankavstämning/,
    /från Bankavstämning/,
    /Rapporter → Bankavstämning/,
    /under Bank reconciliation/,
    /from Bank reconciliation/,
    /Reports → Bank reconciliation/,
    /Open Bank reconciliation/,
    /Bankavstämning →/,
  ]

  for (const file of files) {
    it(`${file} sends nobody to a page that is not in the menu`, () => {
      const text = readFileSync(join(root, file), 'utf8')
      for (const pattern of stale) {
        expect(text, `${file} matches ${pattern}`).not.toMatch(pattern)
      }
    })
  }
})
