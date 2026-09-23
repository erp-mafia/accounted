import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

// The reconciler orchestrates the shared underlag helpers; those are covered
// in inbox-underlag.test.ts, so here they are mocked and the run's own
// logic is what is under test: grouping, dry-run vs execute, classification,
// the history trail, the scan cap, and never throwing.
const resolveBooked = vi.fn()
const resolveAnchoring = vi.fn()
const propagate = vi.fn()
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  resolveBookedJournalEntryIds: (...a: unknown[]) => resolveBooked(...a),
  resolveUnderlagAnchoring: (...a: unknown[]) => resolveAnchoring(...a),
  propagateUnderlagForBookedTransaction: (...a: unknown[]) => propagate(...a),
}))

const appendHistory = vi.fn()
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistoryWithClient: (...a: unknown[]) => appendHistory(...a),
}))

import {
  reconcileStrandedInboxUnderlag,
  INBOX_UNDERLAG_RECONCILED_EVENT,
} from '../inbox-underlag-reconcile'

const C1 = 'company-1'
const C2 = 'company-2'
const TX1 = 'tx-1'
const TX2 = 'tx-2'
const TX3 = 'tx-3'
const JE1 = 'je-1'
const JE2 = 'je-2'

function item(id: string, company: string, tx: string, doc: string | null = `doc-${id}`) {
  return { id, company_id: company, matched_transaction_id: tx, document_id: doc }
}

function anchoring(
  entries: Record<string, 'anchored' | 'unlinked' | 'unlinked_locked' | 'anchored_elsewhere'>,
) {
  return new Map(
    Object.entries(entries).map(([id, status]) => [
      id,
      { status, document_journal_entry_id: status === 'anchored_elsewhere' ? 'je-other' : null },
    ]),
  )
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  propagate.mockResolvedValue(undefined)
  appendHistory.mockResolvedValue('event-1')
})

describe('reconcileStrandedInboxUnderlag', () => {
  it('dry-run classifies without writing and counts stranded items', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [item('i1', C1, TX1), item('i2', C1, TX2), item('i3', C1, TX3)] })
    // TX3 is not booked: its item is scanned but not stranded.
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1], [TX2, JE2]]))
    resolveAnchoring.mockResolvedValue(anchoring({ i1: 'unlinked', i2: 'anchored_elsewhere' }))

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: false,
      log: log as never,
    })

    expect(summary).toMatchObject({
      execute: false,
      scanned: 3,
      truncated: false,
      strandedOnBooked: 2,
      repaired: 0,
      stillUnlinked: 1,
      anchoredElsewhere: 1,
      companiesTouched: 1,
      historyAppended: 0,
      failures: 0,
    })
    expect(propagate).not.toHaveBeenCalled()
    expect(appendHistory).not.toHaveBeenCalled()
    expect(resolveAnchoring).toHaveBeenCalledTimes(1)
    expect(resolveAnchoring).toHaveBeenCalledWith(expect.anything(), C1, [
      { id: 'i1', document_id: 'doc-i1', journalEntryId: JE1 },
      { id: 'i2', document_id: 'doc-i2', journalEntryId: JE2 },
    ])
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
  })

  it('execute propagates unlinked and anchored transactions but logs history only for repaired ones', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Two items on TX1 (a samlingsverifikat) and one on TX2.
    enqueue({ data: [item('i1', C1, TX1), item('i2', C1, TX1), item('i3', C1, TX2)] })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1], [TX2, JE2]]))
    resolveAnchoring
      .mockResolvedValueOnce(anchoring({ i1: 'unlinked', i2: 'anchored', i3: 'anchored' })) // before
      .mockResolvedValueOnce(anchoring({ i1: 'anchored' })) // after, only the linked item is re-read

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
      actorId: 'test-actor',
    })

    // TX2's item was already anchored, so its link is settled, but the
    // propagation still runs for the legs only it covers (the transaction's
    // pinned document, the created_journal_entry_id stamp); only TX1's
    // unlinked item is re-read afterwards.
    expect(propagate).toHaveBeenCalledTimes(2)
    expect(propagate).toHaveBeenCalledWith(expect.anything(), C1, TX1, JE1)
    expect(propagate).toHaveBeenCalledWith(expect.anything(), C1, TX2, JE2)
    expect(resolveAnchoring).toHaveBeenCalledTimes(2)
    expect(resolveAnchoring).toHaveBeenNthCalledWith(2, expect.anything(), C1, [
      { id: 'i1', document_id: 'doc-i1', journalEntryId: JE1 },
    ])
    expect(summary).toMatchObject({
      strandedOnBooked: 3,
      repaired: 1,
      alreadyAnchored: 2,
      stillUnlinked: 0,
      anchoredElsewhere: 0,
      historyAppended: 1,
      failures: 0,
    })
    // Only TX1 changed linkage (i1); TX2's item was already anchored, so no
    // changelog row pretends a repair happened there.
    expect(appendHistory).toHaveBeenCalledTimes(1)
    expect(appendHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: C1,
        aggregateType: 'BankTransaction',
        aggregateId: TX1,
        correlationId: TX1,
        eventType: INBOX_UNDERLAG_RECONCILED_EVENT,
        payload: {
          transaction_id: TX1,
          journal_entry_id: JE1,
          inbox_item_ids: ['i1'],
          source: 'test-actor',
        },
        actor: { type: 'system', id: 'test-actor' },
      }),
    )
  })

  it('counts a link that failed again as still unlinked and appends nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [item('i1', C1, TX1)] })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1]]))
    resolveAnchoring
      .mockResolvedValueOnce(anchoring({ i1: 'unlinked' }))
      .mockResolvedValueOnce(anchoring({ i1: 'unlinked' }))

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
    })

    expect(summary).toMatchObject({ repaired: 0, stillUnlinked: 1, historyAppended: 0 })
    expect(appendHistory).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('still unlinked'),
      expect.objectContaining({ inbox_item_id: 'i1', transaction_id: TX1 }),
    )
  })

  it('counts a document anchored to another verifikat as a conflict, greppable by its verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [item('i1', C1, TX1)] })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1]]))
    // Settled from the pre-state alone: no propagation, no after-read.
    resolveAnchoring.mockResolvedValue(anchoring({ i1: 'anchored_elsewhere' }))

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
    })

    expect(summary).toMatchObject({ repaired: 0, anchoredElsewhere: 1, historyAppended: 0 })
    expect(propagate).not.toHaveBeenCalled()
    expect(resolveAnchoring).toHaveBeenCalledTimes(1)
    expect(appendHistory).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('another verifikat'),
      expect.objectContaining({ inbox_item_id: 'i1', document_journal_entry_id: 'je-other' }),
    )
  })

  it('treats an item the anchoring read could not classify as unlinked, never repaired', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [item('i1', C1, TX1)] })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1]]))
    resolveAnchoring.mockResolvedValue(new Map())

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
    })

    expect(summary).toMatchObject({ repaired: 0, stillUnlinked: 1, historyAppended: 0 })
  })

  it('groups per company and skips companies with no booked matches', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [item('i1', C1, TX1), item('i2', C2, TX2)] })
    resolveBooked.mockImplementation(async (_s: unknown, companyId: string) =>
      companyId === C1 ? new Map([[TX1, JE1]]) : new Map(),
    )
    resolveAnchoring
      .mockResolvedValueOnce(anchoring({ i1: 'unlinked' }))
      .mockResolvedValueOnce(anchoring({ i1: 'anchored' }))

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
    })

    expect(resolveBooked).toHaveBeenCalledWith(expect.anything(), C1, [TX1])
    expect(resolveBooked).toHaveBeenCalledWith(expect.anything(), C2, [TX2])
    expect(summary).toMatchObject({ scanned: 2, strandedOnBooked: 1, companiesTouched: 1, repaired: 1 })
    expect(propagate).toHaveBeenCalledTimes(1)
  })

  it('reads every candidate and spends maxItems on unlinked items only, deferring the rest', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    // Six candidates: two already anchored, one anchored elsewhere, three
    // unlinked. A read cap would have stopped at the first rows; the link
    // budget (2) must reach past the settled ones and defer only the third
    // unlinked item.
    enqueue({
      data: [
        item('a1', C1, TX1),
        item('a2', C1, TX1),
        item('e1', C1, TX2),
        item('u1', C1, TX3),
        item('u2', C2, 'tx-4'),
        item('u3', C2, 'tx-5'),
      ],
    })
    resolveBooked.mockImplementation(async (_s: unknown, companyId: string) =>
      companyId === C1
        ? new Map([[TX1, JE1], [TX2, JE2], [TX3, 'je-3']])
        : new Map([['tx-4', 'je-4'], ['tx-5', 'je-5']]),
    )
    resolveAnchoring.mockImplementation(async (_s: unknown, companyId: string) =>
      companyId === C1
        ? anchoring({ a1: 'anchored', a2: 'anchored', e1: 'anchored_elsewhere', u1: 'unlinked' })
        : anchoring({ u2: 'unlinked', u3: 'unlinked' }),
    )

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      maxItems: 2,
      log: log as never,
    })

    expect(findCalls('invoice_inbox_items', 'range')).toEqual([[0, 999]])
    expect(summary).toMatchObject({
      scanned: 6,
      strandedOnBooked: 6,
      alreadyAnchored: 2,
      anchoredElsewhere: 1,
      deferred: 1,
      truncated: true,
    })
    // u1 and u2 got the budget; u3 waits for the next run, without a
    // misleading "still unlinked after re-run" line. TX1 (anchored items)
    // is propagated outside the budget for its pin and stamp legs; the
    // anchored-elsewhere conflict on TX2 is not.
    expect(propagate).toHaveBeenCalledTimes(3)
    expect(propagate).toHaveBeenCalledWith(expect.anything(), C1, TX1, JE1)
    expect(propagate).toHaveBeenCalledWith(expect.anything(), C1, TX3, 'je-3')
    expect(propagate).toHaveBeenCalledWith(expect.anything(), C2, 'tx-4', 'je-4')
    expect(propagate).not.toHaveBeenCalledWith(expect.anything(), C1, TX2, JE2)
    expect(propagate).not.toHaveBeenCalledWith(expect.anything(), C2, 'tx-5', 'je-5')
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('link budget spent'),
      expect.objectContaining({ max_items: 2, deferred: 1 }),
    )
  })

  it('pages through more than one page of candidates', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const firstPage = Array.from({ length: 1000 }, (_, i) => item(`p${i}`, C1, TX1))
    enqueue({ data: firstPage })
    enqueue({ data: [item('tail', C1, TX1)] })
    resolveBooked.mockResolvedValue(new Map())

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: false,
      log: log as never,
    })

    expect(summary.scanned).toBe(1001)
    expect(summary.truncated).toBe(false)
    expect(findCalls('invoice_inbox_items', 'range')).toEqual([[0, 999], [1000, 1999]])
  })

  it('still propagates a transaction whose only item is anchored so an unlinked pin is repaired', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // i1's own document is anchored; i2 carries no document at all. Both
    // read 'anchored', but the transaction may still have a pinned document
    // (transactions.document_id) whose link failed earlier, and the items
    // still lack their stamp: only the propagation repairs those.
    enqueue({ data: [item('i1', C1, TX1), item('i2', C1, TX2, null)] })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1], [TX2, JE2]]))
    resolveAnchoring.mockResolvedValue(anchoring({ i1: 'anchored', i2: 'anchored' }))

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      maxItems: 0,
      log: log as never,
    })

    // Outside the link budget (maxItems 0 still lets this run), no after-read
    // (the pre-state is the verdict) and no history: nothing this run can
    // vouch for changed the item's linkage.
    expect(propagate).toHaveBeenCalledTimes(2)
    expect(propagate).toHaveBeenCalledWith(expect.anything(), C1, TX1, JE1)
    expect(propagate).toHaveBeenCalledWith(expect.anything(), C1, TX2, JE2)
    expect(resolveAnchoring).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({
      strandedOnBooked: 2,
      repaired: 0,
      alreadyAnchored: 2,
      deferred: 0,
      truncated: false,
      historyAppended: 0,
    })
    expect(appendHistory).not.toHaveBeenCalled()
  })

  it('counts a locked-period item separately, never propagates it, and appends nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [item('i1', C1, TX1)] })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1]]))
    resolveAnchoring.mockResolvedValue(anchoring({ i1: 'unlinked_locked' }))

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
    })

    expect(summary).toMatchObject({
      strandedOnBooked: 1,
      repaired: 0,
      stillUnlinked: 0,
      unlinkedLocked: 1,
      deferred: 0,
      truncated: false,
      historyAppended: 0,
    })
    // The link is known to fail (enforce_period_lock_documents): no
    // propagation, no budget spent, no daily "still unlinked" warning.
    expect(propagate).not.toHaveBeenCalled()
    expect(appendHistory).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('locked period'),
      expect.objectContaining({ inbox_item_id: 'i1' }),
    )
  })

  it('does not count an unreadable pre-state that reads anchored afterwards as repaired', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [item('i1', C1, TX1)] })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1]]))
    resolveAnchoring
      .mockResolvedValueOnce(new Map()) // before: document row unreadable
      .mockResolvedValueOnce(anchoring({ i1: 'anchored' })) // after

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
    })

    // Unknown before is a reason to look (propagate), not evidence that this
    // run changed the linkage: no InboxUnderlagReconciled event.
    expect(propagate).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ repaired: 0, alreadyAnchored: 1, historyAppended: 0 })
    expect(appendHistory).not.toHaveBeenCalled()
  })

  it('returns a zero summary with one failure when the scan errors, without throwing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection reset' } })

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
    })

    expect(summary).toMatchObject({ scanned: 0, strandedOnBooked: 0, repaired: 0, failures: 1 })
    expect(propagate).not.toHaveBeenCalled()
  })

  it('counts a failing company and continues with the next one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [item('i1', C1, TX1), item('i2', C2, TX2)] })
    resolveBooked.mockImplementation(async (_s: unknown, companyId: string) => {
      if (companyId === C1) throw new Error('resolver blew up')
      return new Map([[TX2, JE2]])
    })
    resolveAnchoring
      .mockResolvedValueOnce(anchoring({ i2: 'unlinked' }))
      .mockResolvedValueOnce(anchoring({ i2: 'anchored' }))

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
    })

    expect(summary).toMatchObject({ failures: 1, companiesTouched: 1, repaired: 1 })
    expect(propagate).toHaveBeenCalledWith(expect.anything(), C2, TX2, JE2)
  })

  it('keeps the repair when the history append fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [item('i1', C1, TX1)] })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1]]))
    resolveAnchoring
      .mockResolvedValueOnce(anchoring({ i1: 'unlinked' }))
      .mockResolvedValueOnce(anchoring({ i1: 'anchored' }))
    appendHistory.mockRejectedValue(new Error('fk violation'))

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
    })

    expect(summary).toMatchObject({ repaired: 1, historyAppended: 0, failures: 0 })
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('processing_history append failed'),
      expect.objectContaining({ transaction_id: TX1 }),
    )
  })
})
