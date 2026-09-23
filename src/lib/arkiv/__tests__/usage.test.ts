import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { arkivUsageSummary, recordArkivUsage, sumUsage, usageSince } from '../usage'

const mock = createQueuedMockSupabase()
const { enqueue, reset, findCalls } = mock
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
    expect(rpc).toHaveBeenCalledWith('arkiv_usage_add', { p_company_id: 'co-1', p_activity: 'pages_read', p_units: 7 })
    await recordArkivUsage(supabase, 'co-1', 'asks', 0)
    await recordArkivUsage(supabase, 'co-1', 'asks', Number.NaN)
    expect(rpc).toHaveBeenCalledTimes(1)
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

describe('arkivUsageSummary', () => {
  it('counts a rolling window from today inclusive', () => {
    expect(usageSince(365, new Date('2026-09-17T10:00:00Z'))).toBe('2025-09-18')
    expect(usageSince(1, new Date('2026-09-17T23:59:00Z'))).toBe('2026-09-17')
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

  it('reads the company rows since the window start', async () => {
    enqueue({ data: [{ activity: 'documents', units: 2 }] })
    const out = await arkivUsageSummary(supabase, 'co-1', { days: 30, today: new Date('2026-09-17T10:00:00Z') })
    expect(out).toMatchObject({ since: '2026-08-19', days: 30, documents: 2 })
    expect(findCalls('arkiv_usage_daily', 'gte')).toEqual([['day', '2026-08-19']])
    enqueue({ error: { message: 'boom' } })
    await expect(arkivUsageSummary(supabase, 'co-1')).rejects.toThrow('usage read failed: boom')
  })
})
