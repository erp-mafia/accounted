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
      failureReasons: [],
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
      failureReasons: [],
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

describe('the reasons of a batch\'s failed rows', () => {
  const BUSY = 'En annan ändring av bankkontona pågår just nu. Vänta en stund och försök igen.'
  const LOCKED = 'Perioden är låst.'

  it('groups the failed rows by reason, the most common first', () => {
    const tally = tallyBatchOutcomes(
      ['a', 'b', 'c', 'd', 'e'],
      [
        { ok: false, journalEntryId: null, failureReason: LOCKED },
        { ok: false, journalEntryId: null, failureReason: BUSY },
        { ok: true, journalEntryId: 'je-1' },
        { ok: false, journalEntryId: null, failureReason: BUSY },
        { ok: false, journalEntryId: null, failureReason: ` ${BUSY} ` },
      ],
    )
    expect(tally.failedCount).toBe(4)
    expect(tally.failureReasons).toEqual([
      { reason: BUSY, count: 3 },
      { reason: LOCKED, count: 1 },
    ])
  })

  it('keeps a failed row without a reason in the count only', () => {
    const tally = tallyBatchOutcomes(
      ['told-itself', 'missing', 'blank'],
      [{ ok: false, journalEntryId: null }, undefined, { ok: false, journalEntryId: null, failureReason: '  ' }],
    )
    expect(tally.failedCount).toBe(3)
    expect(tally.failureReasons).toEqual([])
  })

  it('never reads a reason off a booked or a held-back row', () => {
    const tally = tallyBatchOutcomes(
      ['booked', 'flagged'],
      [
        { ok: true, journalEntryId: 'je-1', failureReason: LOCKED },
        { ok: false, journalEntryId: null, deferredDuplicate: true, failureReason: LOCKED },
      ],
    )
    expect(tally.failureReasons).toEqual([])
  })

  it('carries the reason of a failed duplicate retry and merges it with the first pass', async () => {
    const base = tallyBatchOutcomes(
      ['busy', 'locked', 'flagged-1', 'flagged-2'],
      [
        { ok: false, journalEntryId: null, failureReason: BUSY },
        { ok: false, journalEntryId: null, failureReason: LOCKED },
        { ok: false, journalEntryId: null, deferredDuplicate: true },
        { ok: false, journalEntryId: null, deferredDuplicate: true },
      ],
    )
    const retried = await runDeferredDuplicateRetries(
      [
        deferredBooking('flagged-1', async () => ({ ok: false, journalEntryId: null, failureReason: LOCKED })),
        deferredBooking('flagged-2', async () => ({ ok: false, journalEntryId: null, failureReason: LOCKED })),
      ],
      2,
    )
    const folded = foldDeferredRetries(base, retried)
    expect(folded.failedCount).toBe(4)
    expect(folded.failureReasons).toEqual([
      { reason: LOCKED, count: 3 },
      { reason: BUSY, count: 1 },
    ])
    // The first pass's own tally is not changed by the fold.
    expect(base.failureReasons).toEqual([
      { reason: BUSY, count: 1 },
      { reason: LOCKED, count: 1 },
    ])
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
      failureReasons: [],
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
      failureReasons: [],
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
      failureReasons: [],
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
      failureReasons: [],
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
      failureReasons: [],
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
