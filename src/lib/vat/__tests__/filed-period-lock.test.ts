/**
 * filedPeriodLock: what the Moms page says about the books beside a filed
 * period, and when it offers the lock. The verdict is the ledger kernel's
 * (periodLockVerdict); these cases pin what each verdict becomes on the page.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { filedPeriodLock, readFiledPeriodLock, type FiscalYearLockFacts } from '../filed-period-lock'

const YEAR_2025: FiscalYearLockFacts = { id: 'fy-2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true, locked_at: null }
const YEAR_2026: FiscalYearLockFacts = { id: 'fy-2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null }
const YEARS = [YEAR_2025, YEAR_2026]

/** Kvartal 3 2026 ends here. */
const Q3_END = '2026-09-30'

describe('filedPeriodLock', () => {
  it('offers the lock through the last day when no lock date is set', () => {
    expect(filedPeriodLock(Q3_END, null, YEARS)).toEqual({ state: 'open', lockThrough: Q3_END, openYearEnd: null })
    expect(filedPeriodLock(Q3_END, undefined, YEARS)).toEqual({ state: 'open', lockThrough: Q3_END, openYearEnd: null })
  })

  it('offers it when the lock date stops short of the last day, even by one day', () => {
    expect(filedPeriodLock(Q3_END, '2026-06-30', YEARS)).toEqual({ state: 'open', lockThrough: Q3_END, openYearEnd: null })
    expect(filedPeriodLock(Q3_END, '2026-09-29', YEARS)).toEqual({ state: 'open', lockThrough: Q3_END, openYearEnd: null })
  })

  it('reads locked on the last day itself, naming the lock date', () => {
    expect(filedPeriodLock(Q3_END, Q3_END, YEARS)).toEqual({ state: 'locked', through: Q3_END })
  })

  it('names the real lock date when it lies past the period, never the period end', () => {
    expect(filedPeriodLock(Q3_END, '2026-10-31', YEARS)).toEqual({ state: 'locked', through: '2026-10-31' })
  })

  it('offers nothing in a closed räkenskapsår: the year holds the period by itself', () => {
    expect(filedPeriodLock('2025-12-31', null, YEARS)).toEqual({ state: 'year_shut' })
    expect(filedPeriodLock('2025-12-31', '2025-06-30', YEARS)).toEqual({ state: 'year_shut' })
  })

  it('offers nothing in a locked räkenskapsår either', () => {
    const locked = [{ ...YEAR_2026, locked_at: '2026-10-05T08:00:00Z' }]
    expect(filedPeriodLock(Q3_END, null, locked)).toEqual({ state: 'year_shut' })
  })

  it('lets the lock date speak first when both cover the day', () => {
    expect(filedPeriodLock('2025-12-31', '2026-03-31', YEARS)).toEqual({ state: 'locked', through: '2026-03-31' })
  })

  it('judges a helårsmoms period by the last day of its räkenskapsår', () => {
    const broken: FiscalYearLockFacts[] = [
      { id: 'fy-2526', period_start: '2025-07-01', period_end: '2026-06-30', is_closed: false, locked_at: null },
    ]
    // The period ends on the last day of a year that is not closed: its bokslut would be held.
    expect(filedPeriodLock('2026-06-30', '2026-05-31', broken)).toEqual({
      state: 'open',
      lockThrough: '2026-06-30',
      openYearEnd: '2026-06-30',
    })
    expect(filedPeriodLock('2026-06-30', '2026-06-30', broken)).toEqual({ state: 'locked', through: '2026-06-30' })
  })

  it('offers the lock when no räkenskapsår on record covers the day', () => {
    // 2026 ends before that day and is not closed: named, as below.
    expect(filedPeriodLock('2027-03-31', null, YEARS)).toEqual({
      state: 'open',
      lockThrough: '2027-03-31',
      openYearEnd: '2026-12-31',
    })
  })
})

// The lock date holds every earlier day too. A year that is not closed yet
// and ends on or before the day to lock through cannot get its bokslut
// booked behind the lock, so the offer carries that year's last day.
describe('filedPeriodLock: an unclosed räkenskapsår behind the lock', () => {
  const OPEN_2025: FiscalYearLockFacts = { ...YEAR_2025, is_closed: false }

  it('names the year when January is filed before last year is closed', () => {
    expect(filedPeriodLock('2026-01-31', null, [OPEN_2025, YEAR_2026])).toEqual({
      state: 'open',
      lockThrough: '2026-01-31',
      openYearEnd: '2025-12-31',
    })
  })

  it('names it when the period ends on the last day of its own open year (the fourth quarter)', () => {
    expect(filedPeriodLock('2026-12-31', '2026-09-30', YEARS)).toEqual({
      state: 'open',
      lockThrough: '2026-12-31',
      openYearEnd: '2026-12-31',
    })
  })

  it('names the newest when several are open', () => {
    const open2024: FiscalYearLockFacts = { id: 'fy-2024', period_start: '2024-01-01', period_end: '2024-12-31', is_closed: false, locked_at: null }
    expect(filedPeriodLock('2026-03-31', null, [open2024, OPEN_2025, YEAR_2026])).toMatchObject({ openYearEnd: '2025-12-31' })
  })

  it('names none when every earlier year is closed and the period ends inside its year', () => {
    expect(filedPeriodLock(Q3_END, null, YEARS)).toMatchObject({ state: 'open', openYearEnd: null })
  })

  it('counts a year that is locked but not closed: its bokslut is still to come', () => {
    const lockedOnly: FiscalYearLockFacts = { ...OPEN_2025, locked_at: '2026-01-15T08:00:00Z' }
    expect(filedPeriodLock('2026-01-31', null, [lockedOnly, YEAR_2026])).toMatchObject({ openYearEnd: '2025-12-31' })
  })
})

// The MCP tools hold neither the settings nor the fiscal years: they read
// the two facts and get the same verdict the Moms page shows.
describe('readFiledPeriodLock', () => {
  async function read(settings: { data?: unknown; error?: unknown }, years: { data?: unknown; error?: unknown }) {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue(settings)
    enqueue(years)
    const lock = await readFiledPeriodLock(supabase as never, 'company-1', Q3_END)
    return { lock, findCalls }
  }

  it('answers what filedPeriodLock answers for the stored lock date and years', async () => {
    const open = await read({ data: { bookkeeping_locked_through: '2026-06-30' } }, { data: YEARS })
    expect(open.lock).toEqual(filedPeriodLock(Q3_END, '2026-06-30', YEARS))
    expect(open.lock).toMatchObject({ state: 'open' })

    const locked = await read({ data: { bookkeeping_locked_through: '2026-10-31' } }, { data: YEARS })
    expect(locked.lock).toEqual({ state: 'locked', through: '2026-10-31' })
  })

  it('reads the company its caller names, and only what the verdict needs', async () => {
    const { findCalls } = await read({ data: { bookkeeping_locked_through: null } }, { data: YEARS })

    expect(findCalls('company_settings', 'select')).toEqual([['bookkeeping_locked_through']])
    expect(findCalls('company_settings', 'eq')).toEqual([['company_id', 'company-1']])
    expect(findCalls('fiscal_periods', 'select')).toEqual([['id, period_start, period_end, is_closed, locked_at']])
    expect(findCalls('fiscal_periods', 'eq')).toEqual([['company_id', 'company-1']])
  })

  it('takes a company with no settings row or no years as not locked', async () => {
    const { lock } = await read({ data: null }, { data: null })
    expect(lock).toEqual({ state: 'open', lockThrough: Q3_END, openYearEnd: null })
  })

  it.each([
    ['the lock date', { data: null, error: { message: 'timeout' } }, { data: YEARS }],
    ['the fiscal years', { data: { bookkeeping_locked_through: null } }, { data: null, error: { message: 'timeout' } }],
  ])('answers null when %s could not be read: never open by default', async (_what, settings, years) => {
    const { lock } = await read(settings, years)
    expect(lock).toBeNull()
  })
})
