import { describe, it, expect } from 'vitest'
import {
  foldDeferredRetries,
  runDeferredDuplicateRetries,
  tallyBatchOutcomes,
  type BatchCategorizeOutcome,
  type DeferredDuplicateBooking,
} from '@/lib/transactions/batch-duplicates'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'

function candidate(journalEntryId: string): BookedDuplicateCandidate {
  return {
    transaction_id: null,
    journal_entry_id: journalEntryId,
    voucher_label: `A${journalEntryId}`,
    entry_date: '2026-09-01',
    description: 'Spotify AB',
    amount: -119,
    account_number: '1930',
    amount_verified: true,
    currency: null,
    amount_in_currency: null,
    unverified_reason: null,
  }
}

function deferredBooking(
  transactionId: string,
  retry: () => Promise<BatchCategorizeOutcome>,
): DeferredDuplicateBooking {
  return { transactionId, candidate: candidate(transactionId), retry }
}

describe('tallyBatchOutcomes', () => {
  it('splits booked, deferred-duplicate and failed rows', () => {
    const tally = tallyBatchOutcomes(
      ['booked', 'flagged', 'broken', 'flag-flip'],
      [
        { ok: true, journalEntryId: 'je-1' },
        { ok: false, journalEntryId: null, deferredDuplicate: true },
        { ok: false, journalEntryId: null },
        { ok: true, journalEntryId: null },
      ],
    )
    expect(tally).toEqual({
      successCount: 2,
      failedCount: 1,
      deferredCount: 1,
      undoableIds: ['booked'],
    })
  })

  it('never counts a held-back duplicate as a failure', () => {
    const tally = tallyBatchOutcomes(
      ['a', 'b', 'c'],
      [
        { ok: false, journalEntryId: null, deferredDuplicate: true },
        { ok: false, journalEntryId: null, deferredDuplicate: true },
        { ok: false, journalEntryId: null, deferredDuplicate: true },
      ],
    )
    expect(tally.failedCount).toBe(0)
    expect(tally.deferredCount).toBe(3)
  })

  it('counts a missing outcome as a failure instead of throwing', () => {
    const tally = tallyBatchOutcomes(['a', 'b'], [{ ok: true, journalEntryId: 'je-1' }])
    expect(tally).toEqual({
      successCount: 1,
      failedCount: 1,
      deferredCount: 0,
      undoableIds: ['a'],
    })
  })

  it('keeps only rows with a verifikat in the undo set', () => {
    // Ångra alla runs the storno endpoint, which needs a posted entry: a
    // successful flag flip (200, null id) has nothing to reverse.
    const tally = tallyBatchOutcomes(
      ['with-entry', 'flag-flip'],
      [
        { ok: true, journalEntryId: 'je-1' },
        { ok: true, journalEntryId: null },
      ],
    )
    expect(tally.undoableIds).toEqual(['with-entry'])
  })
})

describe('runDeferredDuplicateRetries', () => {
  it('runs every parked retry and tallies what they resolved to', async () => {
    const called: string[] = []
    const deferred = [
      deferredBooking('a', async () => {
        called.push('a')
        return { ok: true, journalEntryId: 'je-a' }
      }),
      deferredBooking('b', async () => {
        called.push('b')
        return { ok: true, journalEntryId: null }
      }),
    ]
    const tally = await runDeferredDuplicateRetries(deferred, 5)
    expect(called.sort()).toEqual(['a', 'b'])
    expect(tally).toEqual({
      successCount: 2,
      failedCount: 0,
      deferredCount: 0,
      undoableIds: ['a'],
    })
  })

  it('counts a retry that resolves as failed, and one that throws, as failures', async () => {
    const deferred = [
      deferredBooking('ok', async () => ({ ok: true, journalEntryId: 'je-ok' })),
      deferredBooking('refused', async () => ({ ok: false, journalEntryId: null })),
      deferredBooking('thrown', async () => {
        throw new Error('network')
      }),
    ]
    const tally = await runDeferredDuplicateRetries(deferred, 5)
    expect(tally.successCount).toBe(1)
    expect(tally.failedCount).toBe(2)
    expect(tally.undoableIds).toEqual(['ok'])
  })

  it('keeps a second candidate deferred instead of asking again', async () => {
    // force is bound to the reviewed candidate, so the server can legitimately
    // flag a different one. The batch asks once: the row stays held back.
    const tally = await runDeferredDuplicateRetries(
      [deferredBooking('a', async () => ({ ok: false, journalEntryId: null, deferredDuplicate: true }))],
      5,
    )
    expect(tally).toEqual({
      successCount: 0,
      failedCount: 0,
      deferredCount: 1,
      undoableIds: [],
    })
  })

  it('never exceeds the concurrency limit and reports progress per finished row', async () => {
    let inFlight = 0
    let peak = 0
    const progress: Array<[number, number]> = []
    const deferred = Array.from({ length: 12 }, (_, i) =>
      deferredBooking(`tx-${i}`, async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight--
        return { ok: true, journalEntryId: `je-${i}` }
      }),
    )
    const tally = await runDeferredDuplicateRetries(deferred, 3, (done, total) =>
      progress.push([done, total]),
    )
    expect(peak).toBeLessThanOrEqual(3)
    expect(tally.successCount).toBe(12)
    expect(progress).toHaveLength(12)
    expect(progress[progress.length - 1]).toEqual([12, 12])
  })

  it('resolves to an empty tally when nothing was deferred', async () => {
    await expect(runDeferredDuplicateRetries([], 5)).resolves.toEqual({
      successCount: 0,
      failedCount: 0,
      deferredCount: 0,
      undoableIds: [],
    })
  })
})

describe('foldDeferredRetries', () => {
  it('replaces the held-back count rather than adding to it', () => {
    const base = tallyBatchOutcomes(
      ['booked', 'flagged', 'broken'],
      [
        { ok: true, journalEntryId: 'je-1' },
        { ok: false, journalEntryId: null, deferredDuplicate: true },
        { ok: false, journalEntryId: null },
      ],
    )
    const retried = tallyBatchOutcomes(['flagged'], [{ ok: true, journalEntryId: 'je-2' }])
    expect(foldDeferredRetries(base, retried)).toEqual({
      successCount: 2,
      failedCount: 1,
      deferredCount: 0,
      undoableIds: ['booked', 'flagged'],
    })
  })

  it('folds a failed retry into the failure count', () => {
    const base = tallyBatchOutcomes(
      ['flagged'],
      [{ ok: false, journalEntryId: null, deferredDuplicate: true }],
    )
    const retried = tallyBatchOutcomes(['flagged'], [{ ok: false, journalEntryId: null }])
    expect(foldDeferredRetries(base, retried)).toEqual({
      successCount: 0,
      failedCount: 1,
      deferredCount: 0,
      undoableIds: [],
    })
  })

  it('carries a still-deferred retry through as held back', () => {
    const base = tallyBatchOutcomes(
      ['flagged'],
      [{ ok: false, journalEntryId: null, deferredDuplicate: true }],
    )
    const retried = tallyBatchOutcomes(
      ['flagged'],
      [{ ok: false, journalEntryId: null, deferredDuplicate: true }],
    )
    expect(foldDeferredRetries(base, retried).deferredCount).toBe(1)
  })
})
