/**
 * Where a storno lands (BFL 5 kap 5 §, BFNAR 2013:2 p. 2.17-2.18): inside the
 * original's fiscal year, which must be open, on the original's date unless
 * a date inside that year is asked for.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
} from '@/lib/bookkeeping/errors'
import { assertStornoTarget } from '../storno-target'

const ORIGINAL = { fiscal_period_id: 'fp-2025', entry_date: '2025-11-15' }
const YEAR_2025 = { name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }
const NO_LOCK_DATE = { data: { bookkeeping_locked_through: null } }

function client(...rest: Array<{ data?: unknown; error?: unknown }>) {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: YEAR_2025 })
  for (const r of rest) mock.enqueue(r)
  return mock
}

describe('assertStornoTarget', () => {
  it('defaults to the original\'s date in an open year', async () => {
    const { supabase, findCalls } = client(NO_LOCK_DATE, { data: { id: 'fp-2025', is_closed: false, locked_at: null } })

    await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL)).resolves.toBe('2025-11-15')
    expect(findCalls('fiscal_periods', 'eq')).toContainEqual(['id', 'fp-2025'])
    expect(findCalls('fiscal_periods', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('accepts another date inside the original\'s year', async () => {
    const { supabase } = client(NO_LOCK_DATE, { data: { id: 'fp-2025', is_closed: false, locked_at: null } })

    await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL, '2025-12-31')).resolves.toBe('2025-12-31')
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
    enqueue({ error: { message: 'connection reset' } })

    await expect(assertStornoTarget(supabase as never, 'company-1', ORIGINAL)).rejects.toBeInstanceOf(FiscalPeriodNotFoundError)
  })
})
