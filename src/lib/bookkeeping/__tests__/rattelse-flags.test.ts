/**
 * The "Rättad" marker in the voucher list at any list size. The answers come
 * from the real route, so a batch over its limit fails here as it does in the
 * browser: "Visa alla" on a ledger of more than 200 vouchers got a 400 and
 * every marker disappeared without a word.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase } from '@/tests/helpers'
import { fetchRattelseFlags, RATTELSE_FLAGS_MAX_IDS } from '../rattelse-flags'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '@/app/api/bookkeeping/journal-entries/rattelse-flags/route'

const ids = (count: number) => Array.from({ length: count }, (_, i) => `entry-${i}`)
const throughRoute = (url: string) => GET(createMockRequest(url, { method: 'GET' }), undefined as never)

describe('fetchRattelseFlags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('asks nothing for an empty list', async () => {
    const request = vi.fn()
    const flags = await fetchRattelseFlags([], request)
    expect(request).not.toHaveBeenCalled()
    expect(flags).toEqual({ corrected: new Set(), incomplete: false })
  })

  it('keeps every marker on a list longer than one request may ask about', async () => {
    enqueue({ data: [{ journal_entry_id: 'entry-3' }], error: null })
    enqueue({ data: [{ journal_entry_id: 'entry-250' }], error: null })
    enqueue({ data: [{ journal_entry_id: 'entry-449' }], error: null })

    const flags = await fetchRattelseFlags(ids(450), throughRoute)

    expect(flags.incomplete).toBe(false)
    expect([...flags.corrected].sort()).toEqual(['entry-250', 'entry-3', 'entry-449'])
  })

  it('asks in batches at the route limit, each id once', async () => {
    const request = vi.fn(async (_url: string) => new Response(JSON.stringify({ data: [] })))
    await fetchRattelseFlags(ids(RATTELSE_FLAGS_MAX_IDS * 2 + 1), request)

    const batches = request.mock.calls.map(([url]) => new URL(url, 'http://x').searchParams.get('ids')!.split(','))
    expect(batches.map((batch) => batch.length)).toEqual([RATTELSE_FLAGS_MAX_IDS, RATTELSE_FLAGS_MAX_IDS, 1])
    expect(new Set(batches.flat()).size).toBe(RATTELSE_FLAGS_MAX_IDS * 2 + 1)
  })

  it('says the answer is incomplete when one batch is refused, and keeps the rest', async () => {
    const request = vi.fn(async (url: string) =>
      url.includes('entry-0,')
        ? new Response(JSON.stringify({ data: ['entry-0'] }))
        : new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    )
    const flags = await fetchRattelseFlags(ids(RATTELSE_FLAGS_MAX_IDS + 1), request)
    expect(flags.incomplete).toBe(true)
    expect([...flags.corrected]).toEqual(['entry-0'])
  })

  it('says the answer is incomplete when the network fails', async () => {
    const flags = await fetchRattelseFlags(ids(2), async () => {
      throw new TypeError('offline')
    })
    expect(flags).toEqual({ corrected: new Set(), incomplete: true })
  })
})
