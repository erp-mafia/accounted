/**
 * cancelDraftEntry: the engine's single writer for leaving the draft state
 * without committing.
 *
 * The properties under test are the ones the v1 DELETE endpoint leans on:
 *   - a draft becomes cancelled and the event fires once
 *   - an already-cancelled draft is returned unchanged, with NO second event
 *   - a posted entry is refused, so no code path can un-post a verifikat
 *     through the cancel door (the immutability trigger permits
 *     posted -> cancelled; the application is what forbids it here)
 *   - the CAS filter on status is what makes the concurrent-commit race safe
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

import { eventBus } from '@/lib/events'
import { cancelDraftEntry } from '../engine'
import { BookkeepingDatabaseError, CannotCancelNonDraftError, JournalEntryNotFoundError } from '../errors'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

const mockEmit = eventBus.emit as ReturnType<typeof vi.fn>

interface Reply {
  data: unknown
  error: { message: string; code?: string } | null
}

/**
 * Queue-driven Supabase double. Every terminal maybeSingle() shifts the next
 * queued reply, so a test spells out the reads and writes in the order the
 * function performs them. `updates` records what was written and under which
 * filters, which is where the CAS assertion lives.
 */
function makeSupabase(replies: Reply[]) {
  const updates: { payload: unknown; filters: Record<string, unknown> }[] = []
  const queue = [...replies]

  const from = vi.fn(() => {
    const filters: Record<string, unknown> = {}
    let payload: unknown
    let isUpdate = false
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn((col: string, val: unknown) => {
        filters[col] = val
        return chain
      }),
      update: vi.fn((p: unknown) => {
        isUpdate = true
        payload = p
        return chain
      }),
      maybeSingle: vi.fn(() => {
        if (isUpdate) updates.push({ payload, filters: { ...filters } })
        const next = queue.shift()
        return Promise.resolve(next ?? { data: null, error: null })
      }),
    }
    return chain
  })

  return { supabase: { from } as never, updates }
}

const DRAFT = {
  id: ENTRY_ID,
  company_id: COMPANY_ID,
  status: 'draft',
  voucher_number: 0,
  voucher_series: 'A',
  entry_date: '2026-05-12',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('cancelDraftEntry', () => {
  it('cancels a draft, emits journal_entry.cancelled once, and CASes on status', async () => {
    const { supabase, updates } = makeSupabase([
      { data: DRAFT, error: null },
      { data: { ...DRAFT, status: 'cancelled' }, error: null },
    ])

    const result = await cancelDraftEntry(supabase, COMPANY_ID, USER_ID, ENTRY_ID)

    expect(result.status).toBe('cancelled')
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ status: 'cancelled' })
    // The three filters together are the guarantee: right row, right tenant,
    // and still a draft at the moment of the write.
    expect(updates[0].filters).toEqual({
      id: ENTRY_ID,
      company_id: COMPANY_ID,
      status: 'draft',
    })
    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit).toHaveBeenCalledWith({
      type: 'journal_entry.cancelled',
      payload: { entry: result, userId: USER_ID, companyId: COMPANY_ID },
    })
  })

  it('is idempotent: an already-cancelled entry comes back unchanged with no write and no event', async () => {
    const cancelled = { ...DRAFT, status: 'cancelled' }
    const { supabase, updates } = makeSupabase([{ data: cancelled, error: null }])

    const result = await cancelDraftEntry(supabase, COMPANY_ID, USER_ID, ENTRY_ID)

    expect(result).toEqual(cancelled)
    expect(updates).toHaveLength(0)
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('refuses a posted entry: storno is the only way out of posted', async () => {
    const { supabase, updates } = makeSupabase([
      { data: { ...DRAFT, status: 'posted', voucher_number: 142 }, error: null },
    ])

    await expect(cancelDraftEntry(supabase, COMPANY_ID, USER_ID, ENTRY_ID)).rejects.toBeInstanceOf(
      CannotCancelNonDraftError,
    )
    // The point is not the error type: it is that nothing was written.
    expect(updates).toHaveLength(0)
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('refuses a reversed entry for the same reason', async () => {
    const { supabase } = makeSupabase([
      { data: { ...DRAFT, status: 'reversed', voucher_number: 142 }, error: null },
    ])

    await expect(
      cancelDraftEntry(supabase, COMPANY_ID, USER_ID, ENTRY_ID),
    ).rejects.toMatchObject({ code: 'CANNOT_CANCEL_NON_DRAFT', currentStatus: 'reversed' })
  })

  it('throws JournalEntryNotFoundError for an unknown id or another tenant s entry', async () => {
    const { supabase } = makeSupabase([{ data: null, error: null }])

    await expect(cancelDraftEntry(supabase, COMPANY_ID, USER_ID, ENTRY_ID)).rejects.toBeInstanceOf(
      JournalEntryNotFoundError,
    )
  })

  it('reports the concurrent commit rather than claiming success when the CAS matches no row', async () => {
    const { supabase } = makeSupabase([
      { data: DRAFT, error: null },
      // Update matched nothing: the entry was committed between read and write.
      { data: null, error: null },
      { data: { status: 'posted' }, error: null },
    ])

    await expect(
      cancelDraftEntry(supabase, COMPANY_ID, USER_ID, ENTRY_ID),
    ).rejects.toMatchObject({ code: 'CANNOT_CANCEL_NON_DRAFT', currentStatus: 'posted' })
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('treats a concurrent cancel as the desired end state', async () => {
    const { supabase } = makeSupabase([
      { data: DRAFT, error: null },
      { data: null, error: null },
      { data: { status: 'cancelled' }, error: null },
    ])

    const result = await cancelDraftEntry(supabase, COMPANY_ID, USER_ID, ENTRY_ID)
    expect(result.status).toBe('cancelled')
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('surfaces a period-lock refusal as a bookkeeping database error, never as a silent success', async () => {
    const { supabase } = makeSupabase([
      { data: DRAFT, error: null },
      {
        data: null,
        error: { message: 'Cannot write to locked/closed fiscal period "2026" (is_closed=t)' },
      },
    ])

    await expect(cancelDraftEntry(supabase, COMPANY_ID, USER_ID, ENTRY_ID)).rejects.toBeInstanceOf(
      BookkeepingDatabaseError,
    )
    expect(mockEmit).not.toHaveBeenCalled()
  })
})
