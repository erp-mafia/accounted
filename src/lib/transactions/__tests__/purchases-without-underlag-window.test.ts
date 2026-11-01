/**
 * The purchases-without-underlag list reaches back from the Swedish calendar
 * day (accounted#18). 23:30 UTC is already the next day in Stockholm, in
 * summer (UTC+2) and in winter (UTC+1).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { fetchPurchasesWithoutUnderlag } from '../purchases-without-underlag'

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchPurchasesWithoutUnderlag: window from the Swedish day', () => {
  it.each([
    ['summer', '2026-07-01T23:30:00Z', '2026-04-02'],
    ['winter', '2026-01-15T23:30:00Z', '2025-10-16'],
  ])('%s: at %s a three-month lookback reads from %s', async (_season, instant, from) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(instant))
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [] })

    const out = await fetchPurchasesWithoutUnderlag(supabase as unknown as SupabaseClient, 'company-1', { lookbackMonths: 3 })

    expect(out).toEqual([])
    expect(findCall('open_bank_rows', 'gte')).toEqual(['date', from])
  })
})
