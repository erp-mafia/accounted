import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('@/lib/bookkeeping/ledger-coverage')

vi.mock('@/lib/bookkeeping/migration-coverage-end', () => ({
  fetchMigrationCoverageEnd: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: vi.fn(),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchMigrationCoverageEnd } from '@/lib/bookkeeping/migration-coverage-end'
import { fetchEntryLines, type FetchEntryLinesOptions } from '@/lib/bookkeeping/entry-lines'
import { ledgerCoverage, ledgerCoveredThrough } from '../ledger-coverage'

const supabase = {} as SupabaseClient

/** Hand-entered vouchers A1, A2, ... on 1686, one per day given. */
function handVouchers(...days: string[]) {
  vi.mocked(fetchEntryLines).mockResolvedValueOnce(
    days.map((day, i) => ({
      account_number: '1686',
      journal_entry: { id: `je-${i + 1}`, entry_date: day, voucher_series: 'A', voucher_number: i + 1 },
    })),
  )
}

/** Run a filter callback against a builder that records each call. */
function recordFilters(filter: (q: unknown) => unknown): Array<[string, unknown[]]> {
  const calls: Array<[string, unknown[]]> = []
  const builder: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop) => (...args: unknown[]) => {
        calls.push([String(prop), args])
        return builder
      },
    },
  )
  filter(builder)
  return calls
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchMigrationCoverageEnd).mockResolvedValue(null)
  vi.mocked(fetchEntryLines).mockResolvedValue([])
})

describe('ledgerCoveredThrough', () => {
  it('is null when nothing from the day on is booked outside the feed', async () => {
    expect(await ledgerCoveredThrough(supabase, 'company-1', ['1686'], '2026-10-01')).toBeNull()
  })

  it('reaches the last hand-entered voucher on the settlement account (crm#1386)', async () => {
    // A samlingsverifikat for 1-17 October, dated the 17th.
    handVouchers('2026-10-09', '2026-10-17')
    expect(await ledgerCoveredThrough(supabase, 'company-1', ['1686'], '2026-10-17')).toBe('2026-10-17')

    const options = vi.mocked(fetchEntryLines).mock.calls[0][0] as FetchEntryLinesOptions
    expect(recordFilters(options.filterEntries)).toEqual([
      ['eq', ['company_id', 'company-1']],
      ['eq', ['status', 'posted']],
      ['eq', ['source_type', 'manual']],
      ['gte', ['entry_date', '2026-10-17']],
    ])
    expect(recordFilters(options.filterLines!)).toEqual([['in', ['account_number', ['1686']]]])
  })

  it('reaches the end of the migrated ledger on any account', async () => {
    vi.mocked(fetchMigrationCoverageEnd).mockResolvedValueOnce('2026-09-28')
    expect(await ledgerCoveredThrough(supabase, 'company-1', ['1686'], '2024-01-01')).toBe('2026-09-28')
  })

  it('ignores a migration that ended before the chosen day', async () => {
    vi.mocked(fetchMigrationCoverageEnd).mockResolvedValueOnce('2026-09-04')
    expect(await ledgerCoveredThrough(supabase, 'company-1', ['1686'], '2026-10-17')).toBeNull()
  })

  it('takes the later of the two', async () => {
    vi.mocked(fetchMigrationCoverageEnd).mockResolvedValueOnce('2026-09-04')
    handVouchers('2026-09-30')
    expect(await ledgerCoveredThrough(supabase, 'company-1', ['1686'], '2026-09-01')).toBe('2026-09-30')
  })

  it('reads no hand vouchers for a connector without a settlement account', async () => {
    expect(await ledgerCoveredThrough(supabase, 'company-1', [], '2026-10-01')).toBeNull()
    expect(fetchEntryLines).not.toHaveBeenCalled()
  })

  it('throws when the vouchers cannot be read: the floor is never guessed', async () => {
    vi.mocked(fetchEntryLines).mockRejectedValueOnce(new Error('statement timeout'))
    await expect(ledgerCoveredThrough(supabase, 'company-1', ['1686'], '2026-10-01')).rejects.toThrow(
      'statement timeout',
    )
  })
})

// crm#1901: a refusal that says only "already booked" leaves the day and its
// source to be found by probing; the coverage names both.
describe('ledgerCoverage', () => {
  it('names the migrated ledger when its last imported voucher sets the day', async () => {
    vi.mocked(fetchMigrationCoverageEnd).mockResolvedValueOnce('2026-11-13')
    // A hand-entered voucher earlier in the range does not set it.
    handVouchers('2026-11-02')
    expect(await ledgerCoverage(supabase, 'company-1', ['1686'], '2026-10-29')).toEqual({
      through: '2026-11-13',
      source: 'migrated_ledger',
    })
  })

  it('names the hand-entered voucher that sets the day', async () => {
    vi.mocked(fetchMigrationCoverageEnd).mockResolvedValueOnce('2026-09-04')
    handVouchers('2026-09-12', '2026-09-30')
    expect(await ledgerCoverage(supabase, 'company-1', ['1686'], '2026-09-01')).toEqual({
      through: '2026-09-30',
      source: 'manual_voucher',
      voucher: { journal_entry_id: 'je-2', voucher_label: 'A2' },
    })
  })

  it('names the hand-entered voucher on a tie: it is the one a reader can open', async () => {
    vi.mocked(fetchMigrationCoverageEnd).mockResolvedValueOnce('2026-09-30')
    handVouchers('2026-09-30')
    expect(await ledgerCoverage(supabase, 'company-1', ['1686'], '2026-09-01')).toMatchObject({
      through: '2026-09-30',
      source: 'manual_voucher',
      voucher: { voucher_label: 'A1' },
    })
  })

  it('is null when nothing from the day on is booked outside the feed', async () => {
    vi.mocked(fetchMigrationCoverageEnd).mockResolvedValueOnce('2026-09-04')
    expect(await ledgerCoverage(supabase, 'company-1', ['1686'], '2026-10-17')).toBeNull()
  })
})
