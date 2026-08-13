import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: vi.fn().mockResolvedValue({}),
}))

import {
  completeInboxItemsForBookedTransaction,
  propagateUnderlagForBookedTransaction,
  resolveBookedJournalEntryIds,
} from '../inbox-underlag'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'

const COMPANY = 'company-1'
const TX1 = 'tx-1'
const TX2 = 'tx-2'
const JE1 = 'je-1'
const JE2 = 'je-2'

describe('resolveBookedJournalEntryIds', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns an empty map without querying for an empty id list', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    const map = await resolveBookedJournalEntryIds(supabase as unknown as SupabaseClient, COMPANY, [])
    expect(map.size).toBe(0)
    expect(calls.length).toBe(0)
  })

  it('resolves direct journal_entry_id and falls back to voucher links', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: TX1, journal_entry_id: JE1 },
        { id: TX2, journal_entry_id: null },
      ],
    })
    // Voucher-link fallback runs only for the unbooked remainder (TX2).
    enqueue({ data: [{ transaction_id: TX2, journal_entry_id: JE2 }] })

    const map = await resolveBookedJournalEntryIds(supabase as unknown as SupabaseClient, COMPANY, [
      TX1,
      TX2,
    ])
    expect(map.get(TX1)).toBe(JE1)
    expect(map.get(TX2)).toBe(JE2)
  })

  it('omits transactions booked by neither route', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: TX1, journal_entry_id: null }] })
    enqueue({ data: [] }) // no voucher links either

    const map = await resolveBookedJournalEntryIds(supabase as unknown as SupabaseClient, COMPANY, [
      TX1,
    ])
    expect(map.size).toBe(0)
  })
})

describe('propagateUnderlagForBookedTransaction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('links the document and stamps the matched item', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'i1', document_id: 'doc-1' }] }) // matched items
    enqueue({ data: { journal_entry_id: null } }) // doc not yet anchored
    enqueue({ data: null }) // stamp update

    await propagateUnderlagForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      JE1,
    )

    expect(linkToJournalEntry).toHaveBeenCalledWith(expect.anything(), COMPANY, 'doc-1', JE1)
    const stamps = findCalls('invoice_inbox_items', 'update')
    expect(stamps).toContainEqual([{ created_journal_entry_id: JE1 }])
  })

  it('skips the document write when it already points at the verifikat', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'i1', document_id: 'doc-1' }] })
    enqueue({ data: { journal_entry_id: JE1 } }) // already anchored to JE1
    enqueue({ data: null }) // stamp update

    await propagateUnderlagForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      JE1,
    )

    expect(linkToJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('invoice_inbox_items', 'update')).toContainEqual([
      { created_journal_entry_id: JE1 },
    ])
  })

  it('never steals a document anchored to another verifikat, and does not stamp', async () => {
    // The doc stays on its verifikat, but THIS transaction's verifikat then
    // has no underlag from the item: stamping it consumed would hide the
    // mismatch from every future run and from manual reconciliation
    // (BFL 5 kap 6-7 §).
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'i1', document_id: 'doc-1' }] })
    enqueue({ data: { journal_entry_id: 'je-other' } })

    await propagateUnderlagForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      JE1,
    )

    expect(linkToJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
  })

  it('stamps an item without a document (no document read)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'i1', document_id: null }] })
    enqueue({ data: null }) // stamp update

    await propagateUnderlagForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      JE1,
    )

    expect(linkToJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('document_attachments', 'select').length).toBe(0)
    expect(findCalls('invoice_inbox_items', 'update')).toContainEqual([
      { created_journal_entry_id: JE1 },
    ])
  })

  it('tolerates the UNIQUE violation when a sibling item already claimed the verifikat', async () => {
    // Samlingsverifikat: created_journal_entry_id is UNIQUE, so on N matched
    // items only the first stamp lands. The rest must resolve quietly: the
    // inbox list derives "booked" from the transaction's state for them.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'i1', document_id: null }] })
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key value' } })

    await expect(
      propagateUnderlagForBookedTransaction(
        supabase as unknown as SupabaseClient,
        COMPANY,
        TX1,
        JE1,
      ),
    ).resolves.toBeUndefined()
  })

  it('does NOT stamp when the document link fails, so a re-run can still repair it', async () => {
    // Stamping over a failed link would hide the item from the
    // `.is('created_journal_entry_id', null)` query forever, leaving a
    // posted verifikation without its underlag reference (BFL 5 kap 6-7 §)
    // and nothing left to surface or repair it.
    vi.mocked(linkToJournalEntry).mockRejectedValueOnce(new Error('period locked'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'i1', document_id: 'doc-1' }] })
    enqueue({ data: { journal_entry_id: null } })

    await expect(
      propagateUnderlagForBookedTransaction(
        supabase as unknown as SupabaseClient,
        COMPANY,
        TX1,
        JE1,
      ),
    ).resolves.toBeUndefined()
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
  })
})

describe('completeInboxItemsForBookedTransaction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is a no-op for an unbooked transaction', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: TX1, journal_entry_id: null }] })
    enqueue({ data: [] }) // no voucher links

    const result = await completeInboxItemsForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
    )
    expect(result).toBeNull()
    expect(findCalls('invoice_inbox_items', 'select').length).toBe(0)
  })

  it('skips the transaction fetch when the caller passes the direct id', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] }) // matched items (none)

    const result = await completeInboxItemsForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      { directJournalEntryId: JE1 },
    )
    expect(result).toBe(JE1)
    expect(findCalls('transactions', 'select').length).toBe(0)
  })

  it('resolves the samlingsverifikat through voucher links when the direct id is null', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ transaction_id: TX1, journal_entry_id: JE2 }] }) // voucher links
    enqueue({ data: [{ id: 'i1', document_id: null }] }) // matched items
    enqueue({ data: null }) // stamp update

    const result = await completeInboxItemsForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      { directJournalEntryId: null },
    )
    expect(result).toBe(JE2)
    expect(findCalls('invoice_inbox_items', 'update')).toContainEqual([
      { created_journal_entry_id: JE2 },
    ])
  })
})
