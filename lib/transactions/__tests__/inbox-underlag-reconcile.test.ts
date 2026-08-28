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

function anchoring(entries: Record<string, 'anchored' | 'unlinked' | 'anchored_elsewhere'>) {
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

  it('execute propagates once per booked transaction and logs history only for repaired ones', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Two items on TX1 (a samlingsverifikat) and one on TX2.
    enqueue({ data: [item('i1', C1, TX1), item('i2', C1, TX1), item('i3', C1, TX2)] })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1], [TX2, JE2]]))
    resolveAnchoring
      .mockResolvedValueOnce(anchoring({ i1: 'unlinked', i2: 'anchored', i3: 'anchored' })) // before
      .mockResolvedValueOnce(anchoring({ i1: 'anchored', i2: 'anchored', i3: 'anchored' })) // after

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
      actorId: 'test-actor',
    })

    expect(propagate).toHaveBeenCalledTimes(2)
    expect(propagate).toHaveBeenCalledWith(expect.anything(), C1, TX1, JE1)
    expect(propagate).toHaveBeenCalledWith(expect.anything(), C1, TX2, JE2)
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
    resolveAnchoring
      .mockResolvedValueOnce(anchoring({ i1: 'anchored_elsewhere' }))
      .mockResolvedValueOnce(anchoring({ i1: 'anchored_elsewhere' }))

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: true,
      log: log as never,
    })

    expect(summary).toMatchObject({ repaired: 0, anchoredElsewhere: 1, historyAppended: 0 })
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

  it('caps the scan at maxItems and reports truncation', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    // maxItems + 1 rows come back: the extra one is the truncation signal.
    enqueue({ data: [item('i1', C1, TX1), item('i2', C1, TX1), item('i3', C1, TX1)] })
    resolveBooked.mockResolvedValue(new Map())

    const summary = await reconcileStrandedInboxUnderlag(supabase as unknown as SupabaseClient, {
      execute: false,
      maxItems: 2,
      log: log as never,
    })

    expect(summary.scanned).toBe(2)
    expect(summary.truncated).toBe(true)
    expect(findCalls('invoice_inbox_items', 'range')).toEqual([[0, 2]])
    expect(resolveBooked).toHaveBeenCalledWith(expect.anything(), C1, [TX1])
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
