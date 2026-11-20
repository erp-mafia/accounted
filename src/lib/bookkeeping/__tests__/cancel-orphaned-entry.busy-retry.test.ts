/**
 * The orphan storno under the busy bank-account lock (cash-account-busy.ts).
 * Live 2026-10-29: a batch of parallel bookings had the storno refused on its
 * lines insert or on the compare-and-set that marks the original reversed;
 * the storno was given up, the verifikat stayed posted beside a row that read
 * as unbooked, and the row was booked a second time. The storno is now tried
 * again while the original still stands, and never once it does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { reverseEntryMock } = vi.hoisted(() => ({ reverseEntryMock: vi.fn() }))

vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: reverseEntryMock,
  cancelOrphanedEntry: vi.fn(),
}))

import { reverseOrphanedJournalEntry } from '../cancel-orphaned-entry'
import { CASH_ACCOUNT_BUSY_RETRY } from '../cash-account-busy'
import { BookkeepingDatabaseError, EntryAlreadyReversedError } from '../errors'

const busyLines = () => new BookkeepingDatabaseError('create_reversal_lines', 'CASH_ACCOUNT_OPERATION_BUSY', 'PT409')
const realDelays = CASH_ACCOUNT_BUSY_RETRY.delaysMs

beforeEach(() => {
  reverseEntryMock.mockReset()
  CASH_ACCOUNT_BUSY_RETRY.delaysMs = [0, 0, 0, 0]
})
afterEach(() => {
  CASH_ACCOUNT_BUSY_RETRY.delaysMs = realDelays
})

const run = (supabase: unknown) =>
  reverseOrphanedJournalEntry(supabase as never, 'company-1', 'user-1', 'je-1', 'Manuell avstämning krävs.')

describe('reverseOrphanedJournalEntry: busy bank-account lock', () => {
  it('tries the storno again when its lines insert was refused busy and the original still stands', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'posted' } }) // the original
    enqueue({ data: [] }) // no posted storno points at it
    reverseEntryMock.mockRejectedValueOnce(busyLines()).mockResolvedValueOnce({ id: 'storno-1' })

    await run(supabase)

    expect(reverseEntryMock).toHaveBeenCalledTimes(2)
  })

  it('tries again after a compare-and-set the lock refused (reported as already reversed) when nothing reversed it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'posted' } })
    enqueue({ data: [] })
    reverseEntryMock.mockRejectedValueOnce(new EntryAlreadyReversedError()).mockResolvedValueOnce({ id: 'storno-1' })

    await run(supabase)

    expect(reverseEntryMock).toHaveBeenCalledTimes(2)
  })

  it('stops when the original was in fact reversed meanwhile', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'reversed' } })
    reverseEntryMock.mockRejectedValueOnce(new EntryAlreadyReversedError())

    await run(supabase)

    expect(reverseEntryMock).toHaveBeenCalledTimes(1)
  })

  it('never stornos twice: a posted storno already pointing at the original stops the retries', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'posted' } })
    enqueue({ data: [{ id: 'storno-live' }] })
    reverseEntryMock.mockRejectedValueOnce(new EntryAlreadyReversedError())

    await run(supabase)

    expect(reverseEntryMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a refusal that is not the lock', async () => {
    const { supabase } = createQueuedMockSupabase()
    reverseEntryMock.mockRejectedValueOnce(new Error('period locked'))

    await run(supabase)

    expect(reverseEntryMock).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('gives up after the configured waits and never throws', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    for (let i = 0; i < 4; i++) {
      enqueue({ data: { status: 'posted' } })
      enqueue({ data: [] })
    }
    reverseEntryMock.mockRejectedValue(busyLines())

    await expect(run(supabase)).resolves.toBeUndefined()

    // The first try plus one per configured wait.
    expect(reverseEntryMock).toHaveBeenCalledTimes(5)
  })
})
