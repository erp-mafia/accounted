import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { recordArkivUsage, sumUsage, usageSince } from '../usage'

const mock = createQueuedMockSupabase()
const { enqueue, reset } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const rpc = mock.supabase.rpc

beforeEach(() => {
  reset()
  vi.clearAllMocks()
})

describe('recordArkivUsage', () => {
  it('adds through the RPC, rounded, and skips nothing-to-count', async () => {
    enqueue({ data: null })
    await recordArkivUsage(supabase, 'co-1', 'pages_read', 7.4)
    expect(rpc).toHaveBeenCalledWith('arkiv_usage_add', { p_company_id: 'co-1', p_activity: 'pages_read', p_units: 7, p_day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    await recordArkivUsage(supabase, 'co-1', 'asks', 0)
    await recordArkivUsage(supabase, 'co-1', 'asks', Number.NaN)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  describe('the day key is the Swedish calendar day (accounted#18)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    // 23:30 UTC is already the next day in Stockholm, in summer (UTC+2) and in
    // winter (UTC+1); the RPC's own default, CURRENT_DATE, is the UTC date.
    it.each([
      ['summer', '2026-07-01T23:30:00Z', '2026-07-02'],
      ['winter', '2026-01-15T23:30:00Z', '2026-01-16'],
    ])('%s: an add at %s counts on %s', async (_season, instant, day) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(instant))
      enqueue({ data: null })
      await recordArkivUsage(supabase, 'co-1', 'pages_vision', 2)
      expect(rpc).toHaveBeenCalledWith('arkiv_usage_add', { p_company_id: 'co-1', p_activity: 'pages_vision', p_units: 2, p_day: day })
    })
  })

  it('never throws: a failed add is a warning, not a stopped pipeline', async () => {
    enqueue({ error: { message: 'permission denied' } })
    await expect(recordArkivUsage(supabase, 'co-1', 'documents', 1)).resolves.toBeUndefined()
    ;(rpc as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('network')
    })
    await expect(recordArkivUsage(supabase, 'co-1', 'documents', 1)).resolves.toBeUndefined()
  })
})

describe('usageSince and sumUsage', () => {
  it('counts a rolling window from today inclusive', () => {
    expect(usageSince(365, new Date('2026-09-17T10:00:00Z'))).toBe('2025-09-18')
    expect(usageSince(1, new Date('2026-09-17T21:59:00Z'))).toBe('2026-09-17')
  })

  it.each([
    ['summer', '2026-07-01T23:30:00Z', '2026-07-02', '2025-07-03'],
    ['winter', '2026-01-15T23:30:00Z', '2026-01-16', '2025-01-17'],
  ])('%s: the window at %s ends on the Swedish day %s (accounted#18)', (_season, instant, today, since365) => {
    expect(usageSince(1, new Date(instant))).toBe(today)
    expect(usageSince(365, new Date(instant))).toBe(since365)
  })

  it('folds the rows per activity and ignores what it does not know', () => {
    expect(sumUsage([{ activity: 'pages_vision', units: 3 }, { activity: 'pages_vision', units: '4' as unknown as number }, { activity: 'other', units: 5 }], '2025-09-18', 365)).toEqual({
      since: '2025-09-18',
      days: 365,
      documents: 0,
      pages_read: 0,
      pages_vision: 7,
      extractions: 0,
      asks: 0,
    })
  })
})
