import { describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import { booksStartFrom, clampToBooksStart, resolveBooksStart } from '../books-start'

const TODAY = '2026-11-04'
const NOW = Date.parse('2026-11-04T10:00:00Z')

function stub(answers: Record<string, TableMockResult[]>) {
  const mock = createTableMockSupabase(answers)
  return { supabase: mock.supabase as never, calls: mock.calls }
}

describe('booksStartFrom', () => {
  it('starts the day after the last imported verifikat, else at the first fiscal period', () => {
    expect(booksStartFrom({ firstPeriodStart: '2024-01-01', lastImportedDate: '2025-12-31', firstOwnEntryDate: null }, TODAY)).toBe('2026-01-01')
    expect(booksStartFrom({ firstPeriodStart: '2026-01-01', lastImportedDate: null, firstOwnEntryDate: null }, TODAY)).toBe('2026-01-01')
  })

  it('takes a migration cutoff inside the open year as it is, not the year start', () => {
    expect(booksStartFrom({ firstPeriodStart: '2025-01-01', lastImportedDate: '2026-09-15', firstOwnEntryDate: '2026-09-20' }, TODAY)).toBe('2026-09-16')
  })

  it('never starts later than the first own verifikat: bookkeeping here reaches back that far', () => {
    expect(booksStartFrom({ firstPeriodStart: '2025-01-01', lastImportedDate: '2026-09-30', firstOwnEntryDate: '2026-07-01' }, TODAY)).toBe('2026-07-01')
  })

  it('stays inside the first fiscal period and never past today', () => {
    expect(booksStartFrom({ firstPeriodStart: '2026-01-01', lastImportedDate: '2024-06-30', firstOwnEntryDate: null }, TODAY)).toBe('2026-01-01')
    expect(booksStartFrom({ firstPeriodStart: '2026-01-01', lastImportedDate: TODAY, firstOwnEntryDate: null }, TODAY)).toBe(TODAY)
  })

  it('has no start for a company without a fiscal period (onboarding)', () => {
    expect(booksStartFrom({ firstPeriodStart: null, lastImportedDate: '2025-12-31', firstOwnEntryDate: '2026-01-02' }, TODAY)).toBeNull()
  })
})

describe('clampToBooksStart', () => {
  const floor = '2026-08-07'
  it('moves a first import that asks for years back up to the books start', () => {
    expect(clampToBooksStart('2024-10-06', '2026-01-01', floor)).toBe('2026-01-01')
  })

  it('never cuts the ordinary window: a start inside it clamps to the window edge only', () => {
    expect(clampToBooksStart('2024-10-06', '2026-10-16', floor)).toBe(floor)
    expect(clampToBooksStart(floor, '2026-10-16', floor)).toBe(floor)
  })

  it('leaves a window that already starts after the books start, and a company without a start, alone', () => {
    expect(clampToBooksStart('2026-09-24', '2026-01-01', floor)).toBe('2026-09-24')
    expect(clampToBooksStart('2024-10-06', null, floor)).toBe('2024-10-06')
  })
})

describe('resolveBooksStart', () => {
  it('reads the first period, the last imported verifikat not dated ahead of its import, and the first own verifikat', async () => {
    const { supabase, calls } = stub({
      fiscal_periods: [{ data: { period_start: '2024-01-01' }, error: null }],
      journal_entries: [
        // An accrual imported in March but dated at year end is passed over.
        { data: [{ entry_date: '2026-10-31', created_at: '2026-03-02T09:00:00Z' }, { entry_date: '2026-02-27', created_at: '2026-03-02T09:00:00Z' }], error: null },
        { data: { entry_date: '2026-05-04' }, error: null },
      ],
    })
    expect(await resolveBooksStart(supabase, 'co-1', { now: NOW })).toBe('2026-02-28')
    const importRead = calls.filter((c) => c.table === 'journal_entries')
    expect(importRead).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'eq', args: ['source_type', 'import'] }),
      expect.objectContaining({ method: 'lte', args: ['entry_date', TODAY] }),
      expect.objectContaining({ method: 'not', args: ['source_type', 'in', '(import,opening_balance)'] }),
    ]))
  })

  it('answers the first fiscal period when nothing is imported and nothing is booked yet', async () => {
    const { supabase } = stub({
      fiscal_periods: [{ data: { period_start: '2026-01-01' }, error: null }],
      journal_entries: [{ data: [], error: null }, { data: null, error: null }],
    })
    expect(await resolveBooksStart(supabase, 'co-1', { now: NOW })).toBe('2026-01-01')
  })

  it('answers null without a fiscal period, and on any failed read (never narrows on a guess), logging the failure', async () => {
    const log = { warn: vi.fn() }
    expect(await resolveBooksStart(stub({ fiscal_periods: [{ data: null, error: null }] }).supabase, 'co-1', { now: NOW, log })).toBeNull()
    expect(log.warn).not.toHaveBeenCalled()
    expect(await resolveBooksStart(stub({ fiscal_periods: [{ data: null, error: { message: 'timeout' } }] }).supabase, 'co-1', { now: NOW, log })).toBeNull()
    expect(log.warn).toHaveBeenCalledWith('books start not read: the first import is not clamped', { companyId: 'co-1', read: 'fiscal_periods', message: 'timeout' })
    expect(await resolveBooksStart(stub({
      fiscal_periods: [{ data: { period_start: '2026-01-01' }, error: null }],
      journal_entries: [{ data: null, error: { message: 'timeout' } }],
    }).supabase, 'co-1', { now: NOW })).toBeNull()
    expect(await resolveBooksStart(stub({
      fiscal_periods: [{ data: { period_start: '2026-01-01' }, error: null }],
      journal_entries: [{ data: [], error: null }, { data: null, error: { message: 'timeout' } }],
    }).supabase, 'co-1', { now: NOW })).toBeNull()
  })
})
