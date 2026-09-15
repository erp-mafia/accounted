import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { loadBooksFindings } from '../findings'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/onboarding/ai-clients.server', () => ({ loadConnectedAiClients: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/bookkeeping/missing-underlag', () => ({ resolveMissingUnderlagEntries: vi.fn().mockResolvedValue([]) }))
const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

describe('findings read integrity', () => {
  beforeEach(() => { vi.clearAllMocks(); reset() })

  it.each(Array.from({ length: 9 }, (_, index) => index))('does not report an empty company when query %s fails', async (failedIndex) => {
    for (let index = 0; index < 9; index++) enqueue({ data: [], count: 0, error: index === failedIndex ? { code: '57014', message: 'timeout' } : null })
    await expect(loadBooksFindings(client, 'company-1', '2026-09-14', 'user-1')).rejects.toMatchObject({ code: '57014' })
  })

  it('orders paginated journal lines and excludes inactive tax connections', async () => {
    enqueue({ data: null, count: 1 })
    enqueue({ data: [{ id: 'period-1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false }] })
    enqueue({ count: 0 }); enqueue({ count: 0 }); enqueue({ data: [] }); enqueue({ count: 0 })
    enqueue({ data: [{ status: 'needs_reconsent' }] }); enqueue({ data: [] }); enqueue({ data: [] })
    enqueue({ data: [{ account_number: '3001', debit_amount: 0, credit_amount: 100 }] })
    enqueue({ data: [] }); enqueue({ data: [] })
    const findings = await loadBooksFindings(client, 'company-1', '2026-09-14', 'user-1')
    expect(findings.books.revenue).toBe(100)
    expect(findings.skv.connected).toBe(false)
    expect(findCall('journal_entry_lines', 'order')).toEqual(['id'])
  })
})
