import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/transactions/migration-coverage', () => ({
  fetchMigrationCoverageEnd: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: vi.fn(),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchMigrationCoverageEnd } from '@/lib/transactions/migration-coverage'
import { fetchEntryLines, type FetchEntryLinesOptions } from '@/lib/bookkeeping/entry-lines'
import { ledgerCoveredThrough } from '../ledger-coverage'

const supabase = {} as SupabaseClient

function handVouchers(...days: string[]) {
  vi.mocked(fetchEntryLines).mockResolvedValueOnce(
    days.map((day) => ({ account_number: '1686', journal_entry: { entry_date: day } })),
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
