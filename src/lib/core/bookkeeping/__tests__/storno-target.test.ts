/**
 * Where a storno lands (BFL 5 kap 5 §, BFNAR 2013:2 p. 2.17-2.18): inside the
 * original's fiscal year, which must be open, on the original's date unless
 * a date inside that year is asked for. Past a close, a lock or the company
 * lock date, the person's correction doors move it to the first open,
 * unlocked period after the original, naming the original.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  BookkeepingDatabaseError,
  EntryAlreadyReversedError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  NoOpenPeriodForDateError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
} from '@/lib/bookkeeping/errors'
import {
  assertStornoTarget,
  correctionDateInFirstOpenPeriod,
  isStandingStorno,
  movedCorrectionDescription,
  movedStornoDescription,
  originalVoucherReference,
} from '../storno-target'

const ORIGINAL = { id: 'orig-1', fiscal_period_id: 'fp-2025', entry_date: '2025-11-15', source_type: 'manual' }
const YEAR_2025 = { name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }
const NO_STORNO = { data: [] }
const NO_LOCK_DATE = { data: { bookkeeping_locked_through: null } }
const MOVE = { inFirstOpenPeriodWhenLocked: true }

const fy = (id: string, start: string, end: string, state: 'open' | 'closed' | 'locked') => ({
  id,
  period_start: start,
  period_end: end,
  is_closed: state === 'closed',
  locked_at: state === 'locked' ? '2026-02-01T00:00:00Z' : null,
})

/** The guard read (no posted storno), the original's year, then `rest`. */
function client(...rest: Array<{ data?: unknown; error?: unknown }>) {
  const mock = createQueuedMockSupabase()
  mock.enqueue(NO_STORNO)
  mock.enqueue({ data: YEAR_2025 })
  for (const r of rest) mock.enqueue(r)
  return mock
}

afterEach(() => {
  vi.useRealTimers()
})

describe('assertStornoTarget', () => {
  it('defaults to the original\'s date in an open year', async () => {
    const { supabase, findCalls } = client(NO_LOCK_DATE, { data: { id: 'fp-2025', is_closed: false, locked_at: null } })

    await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL)).resolves.toEqual({
      date: '2025-11-15',
      fiscal_period_id: 'fp-2025',
      moved: false,
    })
    expect(findCalls('fiscal_periods', 'eq')).toContainEqual(['id', 'fp-2025'])
    expect(findCalls('fiscal_periods', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('accepts another date inside the original\'s year', async () => {
    const { supabase } = client(NO_LOCK_DATE, { data: { id: 'fp-2025', is_closed: false, locked_at: null } })

    await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL, '2025-12-31')).resolves.toMatchObject({
      date: '2025-12-31',
      moved: false,
    })
  })

  it.each(['2026-01-10', '2024-12-31'])('refuses %s, outside the original\'s year', async (date) => {
    const { supabase } = client()

    const err = await assertStornoTarget(supabase as never, 'company-1', ORIGINAL, date).catch((e) => e)

    expect(err).toBeInstanceOf(EntryDateOutsideFiscalPeriodError)
    expect(err).toMatchObject({ entryDate: date, periodStart: '2025-01-01', periodEnd: '2025-12-31' })
  })

  it('refuses a closed year', async () => {
    const { supabase } = client(NO_LOCK_DATE, { data: { id: 'fp-2025', is_closed: true, locked_at: '2026-02-01T00:00:00Z' } })

    await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL)).rejects.toBeInstanceOf(TargetPeriodClosedError)
  })

  it('refuses a locked year', async () => {
    const { supabase } = client(NO_LOCK_DATE, { data: { id: 'fp-2025', is_closed: false, locked_at: '2026-02-01T00:00:00Z' } })

    const err = await assertStornoTarget(supabase as never, 'company-1', ORIGINAL).catch((e) => e)

    expect(err).toBeInstanceOf(TargetPeriodLockedError)
    expect(err.lockDate).toBe('2026-02-01T00:00:00Z')
  })

  it('refuses a date on or before the company lock date', async () => {
    const { supabase } = client({ data: { bookkeeping_locked_through: '2025-11-30' } }, { data: { id: 'fp-2025' } })

    const err = await assertStornoTarget(supabase as never, 'company-1', ORIGINAL).catch((e) => e)

    expect(err).toBeInstanceOf(TargetPeriodLockedError)
    expect(err.lockDate).toBe('2025-11-30')
  })

  it('fails closed when the lock lookup fails', async () => {
    const { supabase } = client({ error: { message: 'connection reset' } })

    await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL)).rejects.toBeInstanceOf(TargetPeriodLockedError)
  })

  it('refuses when the original\'s year cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(NO_STORNO)
    enqueue({ error: { message: 'connection reset' } })

    await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL)).rejects.toBeInstanceOf(FiscalPeriodNotFoundError)
  })

  // A storno moved out of a locked year leaves the original 'posted': the
  // posted storno that points at it is what says it is done.
  it('refuses when a posted storno already reverses the original, before reading its year', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'storno-1' }] })

    await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL, undefined, MOVE)).rejects.toBeInstanceOf(
      EntryAlreadyReversedError,
    )
    expect(findCalls('journal_entries', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['reverses_id', 'orig-1'],
      ['status', 'posted'],
    ])
    expect(findCalls('fiscal_periods', 'select')).toEqual([])
  })

  it('refuses when the posted stornos cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'connection reset' } })

    await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL)).rejects.toBeInstanceOf(
      BookkeepingDatabaseError,
    )
  })

  describe('inFirstOpenPeriodWhenLocked', () => {
    const LOCKED_2025 = { data: { id: 'fp-2025', is_closed: false, locked_at: '2026-02-01T00:00:00Z' } }
    const CLOSED_2025 = { data: { id: 'fp-2025', is_closed: true, locked_at: '2026-02-01T00:00:00Z' } }
    const YEARS = {
      data: [fy('fp-2025', '2025-01-01', '2025-12-31', 'closed'), fy('fp-2026', '2026-01-01', '2026-12-31', 'open')],
    }

    it('moves the storno of a closed year to today in the first open year', async () => {
      vi.useFakeTimers({ now: new Date('2026-11-24T10:00:00Z') })
      const { supabase } = client(NO_LOCK_DATE, CLOSED_2025, NO_LOCK_DATE, YEARS)

      await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL, undefined, MOVE)).resolves.toEqual({
        date: '2026-11-24',
        fiscal_period_id: 'fp-2026',
        moved: true,
      })
    })

    it('moves the storno of a date on or before the company lock date to after it, in the same open year', async () => {
      vi.useFakeTimers({ now: new Date('2025-12-10T10:00:00Z') })
      const lockDate = { data: { bookkeeping_locked_through: '2025-11-30' } }
      const { supabase } = client(lockDate, { data: { id: 'fp-2025' } }, lockDate, {
        data: [fy('fp-2025', '2025-01-01', '2025-12-31', 'open')],
      })

      await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL, undefined, MOVE)).resolves.toEqual({
        date: '2025-12-10',
        fiscal_period_id: 'fp-2025',
        moved: true,
      })
    })

    it('refuses when no fiscal year covers the first open day', async () => {
      vi.useFakeTimers({ now: new Date('2026-11-24T10:00:00Z') })
      const { supabase } = client(NO_LOCK_DATE, CLOSED_2025, NO_LOCK_DATE, {
        data: [fy('fp-2025', '2025-01-01', '2025-12-31', 'closed')],
      })

      const err = await assertStornoTarget(supabase as never, 'company-1', ORIGINAL, undefined, MOVE).catch((e) => e)

      expect(err).toBeInstanceOf(NoOpenPeriodForDateError)
      expect(err.date).toBe('2026-01-01')
    })

    it('refuses when the open years cannot be read', async () => {
      const { supabase } = client(NO_LOCK_DATE, LOCKED_2025, NO_LOCK_DATE, { error: { message: 'connection reset' } })

      await expect(
        assertStornoTarget(supabase as never, 'company-1', ORIGINAL, undefined, MOVE),
      ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    })

    it('never moves a storno for an asked date', async () => {
      const { supabase } = client(NO_LOCK_DATE, LOCKED_2025)

      await expect(
        assertStornoTarget(supabase as never, 'company-1', ORIGINAL, '2025-12-31', MOVE),
      ).rejects.toBeInstanceOf(TargetPeriodLockedError)
    })

    it.each(['opening_balance', 'year_end', 'vat_settlement'])('never moves the storno of a %s verifikat', async (sourceType) => {
      const { supabase } = client(NO_LOCK_DATE, CLOSED_2025)

      await expect(
        assertStornoTarget(supabase as never, 'company-1', { ...ORIGINAL, source_type: sourceType }, undefined, MOVE),
      ).rejects.toBeInstanceOf(TargetPeriodClosedError)
    })

    it('never moves when the lock lookup failed', async () => {
      const { supabase } = client({ error: { message: 'connection reset' } })

      await expect(
        assertStornoTarget(supabase as never, 'company-1', ORIGINAL, undefined, MOVE),
      ).rejects.toBeInstanceOf(TargetPeriodLockedError)
    })
  })
})

describe('correctionDateInFirstOpenPeriod', () => {
  const Y2025 = (state: 'open' | 'closed' | 'locked') => fy('fp-2025', '2025-01-01', '2025-12-31', state)
  const Y2026 = (state: 'open' | 'closed' | 'locked') => fy('fp-2026', '2026-01-01', '2026-12-31', state)
  const Y2027 = (state: 'open' | 'closed' | 'locked') => fy('fp-2027', '2027-01-01', '2027-12-31', state)

  it('is today when today lies in the first open period', () => {
    expect(correctionDateInFirstOpenPeriod('2025-11-15', '2026-11-24', null, [Y2025('closed'), Y2026('open')])).toEqual({
      date: '2026-11-24',
      fiscal_period_id: 'fp-2026',
    })
  })

  it('is the first open period\'s last day when today is past it (an earlier year still open)', () => {
    expect(
      correctionDateInFirstOpenPeriod('2025-11-15', '2027-02-03', null, [Y2025('locked'), Y2026('open'), Y2027('open')]),
    ).toEqual({ date: '2026-12-31', fiscal_period_id: 'fp-2026' })
  })

  it('is the first open day when today is before it', () => {
    expect(correctionDateInFirstOpenPeriod('2026-03-15', '2026-05-02', '2026-06-30', [Y2026('open')])).toEqual({
      date: '2026-07-01',
      fiscal_period_id: 'fp-2026',
    })
  })

  it('steps past the lock date and then every closed or locked year', () => {
    expect(
      correctionDateInFirstOpenPeriod('2025-03-15', '2027-06-01', '2025-06-30', [
        Y2027('open'),
        Y2025('closed'),
        Y2026('locked'),
      ]),
    ).toEqual({ date: '2027-06-01', fiscal_period_id: 'fp-2027' })
  })

  it('names no year when none covers the first open day', () => {
    expect(correctionDateInFirstOpenPeriod('2025-11-15', '2026-11-24', null, [Y2025('closed')])).toEqual({
      date: '2026-01-01',
      fiscal_period_id: null,
    })
  })
})

describe('the texts that name the original', () => {
  const original = { voucher_series: 'b', voucher_number: 12, entry_date: '2025-03-15', description: 'Kontorsmaterial' }

  it('names the voucher with its date', () => {
    expect(originalVoucherReference(original)).toBe('B12 (2025-03-15)')
  })

  it('writes the storno text', () => {
    expect(movedStornoDescription(original)).toBe('Storno av verifikat B12 (2025-03-15): Kontorsmaterial')
  })

  it('writes the corrected verifikat\'s text, or keeps the person\'s own with the reference after it', () => {
    expect(movedCorrectionDescription(original)).toBe('Rättelse av verifikat B12 (2025-03-15): Kontorsmaterial')
    expect(movedCorrectionDescription(original, '   ')).toBe('Rättelse av verifikat B12 (2025-03-15): Kontorsmaterial')
    expect(movedCorrectionDescription(original, ' Kontorsmaterial, konto 6110 ')).toBe(
      'Kontorsmaterial, konto 6110 (rättelse av verifikat B12 (2025-03-15))',
    )
  })
})

describe('isStandingStorno', () => {
  it('is true for the first posted storno of the original, false for a later one', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'storno-1' }] })
    enqueue({ data: [{ id: 'storno-1' }] })

    await expect(isStandingStorno(supabase as never, 'company-1', 'orig-1', 'storno-1')).resolves.toBe(true)
    await expect(isStandingStorno(supabase as never, 'company-1', 'orig-1', 'storno-2')).resolves.toBe(false)
    expect(findCalls('journal_entries', 'order')[0]).toEqual(['voucher_number', { ascending: true }])
  })

  it('throws when the stornos cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'connection reset' } })

    await expect(isStandingStorno(supabase as never, 'company-1', 'orig-1', 'storno-1')).rejects.toBeInstanceOf(
      BookkeepingDatabaseError,
    )
  })
})
