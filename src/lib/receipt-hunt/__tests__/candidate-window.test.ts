/**
 * The receipt hunt's candidates reach twelve months back from the Swedish
 * calendar day (accounted#18). 23:30 UTC is already the next day in
 * Stockholm, in summer (UTC+2) and in winter (UTC+1).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { fetchCandidateTransactions } from '../hunt'

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchCandidateTransactions: window from the Swedish day', () => {
  it.each([
    ['summer', '2026-07-01T23:30:00Z', '2025-07-02'],
    ['winter', '2026-01-15T23:30:00Z', '2025-01-16'],
  ])('%s: at %s it reads from %s', async (_season, instant, from) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(instant))
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await fetchCandidateTransactions(supabase as unknown as SupabaseClient, 'company-1')

    expect(findCall('open_bank_rows', 'gte')).toEqual(['date', from])
  })
})
