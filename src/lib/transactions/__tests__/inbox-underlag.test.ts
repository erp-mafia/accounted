import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: vi.fn().mockResolvedValue({}),
}))
// The delivery an item came in (lib/inkorg/pairs-read.ts); the pairing rule itself runs for real.
const readDeliverySiblings = vi.fn()
vi.mock('@/lib/inkorg/pairs-read', () => ({
  readDeliverySiblings: (...args: unknown[]) => readDeliverySiblings(...args),
}))

import {
  completeInboxItemOnEntry,
  completeInboxItemsForBookedTransaction,
  propagateUnderlagForBookedTransaction,
  resolveBookedJournalEntryIds,
  resolveUnderlagAnchoring,
  stampNewInboxItemIfDocumentLinked,
} from '../inbox-underlag'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'

const COMPANY = 'company-1'
const TX1 = 'tx-1'
const TX2 = 'tx-2'
const JE1 = 'je-1'
const JE2 = 'je-2'


/** A document pinned to the bank row follows the row onto its verifikat. */
const PIN_BASIS = { link_basis: 'system_derived', link_evidence: { rule_id: 'bank_row_document_pin' } }

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

  it('reads a long id list in slices of 200, so the uncapped inbox list never outgrows one in() filter', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    const ids = Array.from({ length: 450 }, (_, i) => `tx-${i}`)

    await resolveBookedJournalEntryIds(supabase as unknown as SupabaseClient, COMPANY, ids)

    const slices = findCalls('transactions', 'in').map((a) => (a[1] as string[]).length)
    expect(slices).toEqual([200, 200, 50])
  })
})

describe('propagateUnderlagForBookedTransaction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('links the document and stamps the matched item', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { document_id: null } }) // tx pin lookup: nothing pinned
    enqueue({ data: [{ id: 'i1', document_id: 'doc-1' }] }) // matched items
    enqueue({ data: { journal_entry_id: null } }) // doc not yet anchored
    enqueue({ data: null }) // stamp update

    await propagateUnderlagForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      JE1,
    )

    expect(linkToJournalEntry).toHaveBeenCalledWith(expect.anything(), COMPANY, 'doc-1', JE1, {
      link_basis: 'system_derived',
      link_evidence: { rule_id: 'inbox_item_bank_row_match' },
    })
    const stamps = findCalls('invoice_inbox_items', 'update')
    expect(stamps).toContainEqual([{ created_journal_entry_id: JE1 }])
  })

  it('skips the document write when it already points at the verifikat', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { document_id: null } }) // tx pin lookup: nothing pinned
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
    enqueue({ data: { document_id: null } }) // tx pin lookup: nothing pinned
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
    enqueue({ data: { document_id: null } }) // tx pin lookup: nothing pinned
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

  it('stamps every matched item on a samlingsverifikat', async () => {
    // N kvitton settled by one bank line share one created_journal_entry_id.
    // The UNIQUE that let only the first stamp land (and made this code
    // swallow 23505 for the rest) was dropped in migration 20260911120500.
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { document_id: null } }) // tx pin lookup: nothing pinned
    enqueue({ data: [{ id: 'i1', document_id: null }, { id: 'i2', document_id: null }] })
    enqueue({ data: null }) // stamp i1
    enqueue({ data: null }) // stamp i2

    await expect(
      propagateUnderlagForBookedTransaction(
        supabase as unknown as SupabaseClient,
        COMPANY,
        TX1,
        JE1,
      ),
    ).resolves.toBeUndefined()
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([
      [{ created_journal_entry_id: JE1 }],
      [{ created_journal_entry_id: JE1 }],
    ])
    // The shared compare-and-set (accounted#14): besides the read's filter,
    // each stamp carries the supplier-invoice predicate, so a conversion
    // that claimed an item after the read keeps it.
    const siPredicates = findCalls('invoice_inbox_items', 'is').filter(
      ([column]) => column === 'created_supplier_invoice_id',
    )
    expect(siPredicates).toHaveLength(3)
  })

  it('does NOT stamp when the document link fails, so a re-run can still repair it', async () => {
    // Stamping over a failed link would hide the item from the
    // `.is('created_journal_entry_id', null)` query forever, leaving a
    // posted verifikation without its underlag reference (BFL 5 kap 6-7 §)
    // and nothing left to surface or repair it.
    vi.mocked(linkToJournalEntry).mockRejectedValueOnce(new Error('period locked'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { document_id: null } }) // tx pin lookup: nothing pinned
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

  // ── The transaction's own pinned document (transactions.document_id) ──
  // A doc attached directly to the transaction has no inbox item to carry
  // it, so the propagation must anchor it itself: this was the 2026-08-13
  // "Underlag saknas" gap (attach-before-book via the manual booking dialog).

  it('anchors the pinned document even when no inbox item exists', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { document_id: 'doc-pin' } }) // tx pin lookup
    enqueue({ data: { journal_entry_id: null } }) // pinned doc not yet anchored
    enqueue({ data: [] }) // inbox stamp by document: no row came from the inbox
    enqueue({ data: [] }) // no matched inbox items

    await propagateUnderlagForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      JE1,
    )

    expect(linkToJournalEntry).toHaveBeenCalledWith(expect.anything(), COMPANY, 'doc-pin', JE1, PIN_BASIS)
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: JE1 }]])
  })

  it('stamps the inbox item a pinned document came from, matched to the transaction or not (agent feedback seq 1003926)', async () => {
    // The document was pinned to the transaction without its inbox item being
    // matched; booking anchored the document and left the item "unprocessed"
    // next to a document already on the verifikat.
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: { document_id: 'doc-pin' } }) // tx pin lookup
    enqueue({ data: { journal_entry_id: null } }) // pinned doc not yet anchored
    enqueue({ data: [{ id: 'item-pin' }] }) // inbox stamp by document
    enqueue({ data: [] }) // no matched inbox items

    await propagateUnderlagForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      JE1,
    )

    const stamp = calls.filter((c) => c.table === 'invoice_inbox_items' && ['update', 'eq', 'is'].includes(c.method))
    expect(stamp.map((c) => [c.method, ...c.args]).slice(0, 5)).toEqual([
      ['update', { created_journal_entry_id: JE1 }],
      ['eq', 'document_id', 'doc-pin'],
      ['eq', 'company_id', COMPANY],
      ['is', 'created_journal_entry_id', null],
      ['is', 'created_supplier_invoice_id', null],
    ])
  })

  it('leaves a pinned document that already points at this verifikat alone, and stamps its inbox item', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { document_id: 'doc-pin' } })
    enqueue({ data: { journal_entry_id: JE1 } }) // already anchored here (bulk-book RPC)
    enqueue({ data: [{ id: 'item-pin' }] }) // inbox stamp by document
    enqueue({ data: [] })

    await propagateUnderlagForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      JE1,
    )

    expect(linkToJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: JE1 }]])
  })

  it('never steals a pinned document anchored to another verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { document_id: 'doc-pin' } })
    enqueue({ data: { journal_entry_id: 'je-other' } })
    enqueue({ data: [] })

    await propagateUnderlagForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      JE1,
    )

    expect(linkToJournalEntry).not.toHaveBeenCalled()
  })

  it('never anchors a superseded version of a pinned document', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { document_id: 'doc-old' } }) // the row's pin
    enqueue({ data: { journal_entry_id: null, is_current_version: false } }) // the document
    enqueue({ data: [] }) // matched items

    await propagateUnderlagForBookedTransaction(supabase as unknown as SupabaseClient, COMPANY, TX1, JE1)

    expect(linkToJournalEntry).not.toHaveBeenCalled()
  })

  it('still processes inbox items when the pinned-document link fails', async () => {
    vi.mocked(linkToJournalEntry).mockRejectedValueOnce(new Error('period locked'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { document_id: 'doc-pin' } })
    enqueue({ data: { journal_entry_id: null } }) // pinned doc; link will throw
    enqueue({ data: [{ id: 'i1', document_id: null }] }) // docless matched item
    enqueue({ data: null }) // stamp update

    await expect(
      propagateUnderlagForBookedTransaction(
        supabase as unknown as SupabaseClient,
        COMPANY,
        TX1,
        JE1,
      ),
    ).resolves.toBeUndefined()
    expect(findCalls('invoice_inbox_items', 'update')).toContainEqual([
      { created_journal_entry_id: JE1 },
    ])
  })

  it('links a document shared by the pin and a matched item only once', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { document_id: 'doc-1' } }) // pin points at the same doc
    enqueue({ data: { journal_entry_id: null } }) // pin leg links it
    enqueue({ data: [{ id: 'i1', document_id: 'doc-1' }] }) // matched item, same doc
    enqueue({ data: { journal_entry_id: JE1 } }) // item leg finds it anchored
    enqueue({ data: null }) // stamp update

    await propagateUnderlagForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      JE1,
    )

    expect(linkToJournalEntry).toHaveBeenCalledTimes(1)
    expect(findCalls('invoice_inbox_items', 'update')).toContainEqual([
      { created_journal_entry_id: JE1 },
    ])
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

  it('skips the resolution fetch when the caller passes the direct id', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { document_id: null } }) // tx pin lookup inside propagate
    enqueue({ data: [] }) // matched items (none)

    const result = await completeInboxItemsForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      { directJournalEntryId: JE1 },
    )
    expect(result).toBe(JE1)
    // The only transactions read is the pin lookup inside the propagation:
    // the id/journal_entry_id resolution query never runs.
    expect(findCalls('transactions', 'select')).toEqual([['document_id']])
  })

  it('resolves the samlingsverifikat through voucher links when the direct id is null', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ transaction_id: TX1, journal_entry_id: JE2 }] }) // voucher links
    enqueue({ data: { document_id: null } }) // tx pin lookup inside propagate
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

  it('anchors a pinned document against the samlingsverifikat on attach-after-bulk-book', async () => {
    // A bulk-booked tx keeps transactions.journal_entry_id null: its verifikat
    // hangs off transaction_voucher_links. A document attached AFTER that
    // booking (with no inbox item) must still land on the samlingsverifikat:
    // voucher-link resolution feeds the pin leg of the propagation.
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ transaction_id: TX1, journal_entry_id: JE2 }] }) // voucher links
    enqueue({ data: { document_id: 'doc-pin' } }) // tx pin lookup
    enqueue({ data: { journal_entry_id: null } }) // pinned doc unanchored
    enqueue({ data: [] }) // inbox stamp by document: no row came from the inbox
    enqueue({ data: [] }) // no matched inbox items

    const result = await completeInboxItemsForBookedTransaction(
      supabase as unknown as SupabaseClient,
      COMPANY,
      TX1,
      { directJournalEntryId: null },
    )
    expect(result).toBe(JE2)
    expect(linkToJournalEntry).toHaveBeenCalledWith(expect.anything(), COMPANY, 'doc-pin', JE2, PIN_BASIS)
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: JE2 }]])
  })
})

describe('resolveUnderlagAnchoring', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads an item without a document as anchored, without querying', async () => {
    // No underlag to carry onto the verifikat: only the stamp is missing.
    const { supabase, calls } = createQueuedMockSupabase()
    const map = await resolveUnderlagAnchoring(supabase as unknown as SupabaseClient, COMPANY, [
      { id: 'i1', document_id: null, journalEntryId: JE1 },
    ])
    expect(map.get('i1')).toEqual({ status: 'anchored', document_journal_entry_id: null })
    expect(calls.length).toBe(0)
  })

  it('classifies anchored, unlinked and anchored_elsewhere from one batched select', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'doc-a', journal_entry_id: JE1 },
        { id: 'doc-b', journal_entry_id: null },
        { id: 'doc-c', journal_entry_id: JE2 },
      ],
    })

    const map = await resolveUnderlagAnchoring(supabase as unknown as SupabaseClient, COMPANY, [
      { id: 'i-a', document_id: 'doc-a', journalEntryId: JE1 },
      { id: 'i-b', document_id: 'doc-b', journalEntryId: JE1 },
      { id: 'i-c', document_id: 'doc-c', journalEntryId: JE1 },
      { id: 'i-none', document_id: null, journalEntryId: JE1 },
    ])

    expect(map.get('i-a')?.status).toBe('anchored')
    expect(map.get('i-b')?.status).toBe('unlinked')
    expect(map.get('i-c')).toEqual({ status: 'anchored_elsewhere', document_journal_entry_id: JE2 })
    expect(map.get('i-none')?.status).toBe('anchored')
    const selects = findCalls('document_attachments', 'select')
    expect(selects.length).toBe(1)
    expect(findCalls('document_attachments', 'in')).toEqual([['id', ['doc-a', 'doc-b', 'doc-c']]])
  })

  it('reads an unlinked item whose verifikat sits in a locked or closed period as unlinked_locked', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'doc-a', journal_entry_id: null },
        { id: 'doc-b', journal_entry_id: null },
        { id: 'doc-c', journal_entry_id: null },
        { id: 'doc-d', journal_entry_id: JE1 },
      ],
    })
    enqueue({
      data: [
        { id: JE1, fiscal_period: { is_closed: false, locked_at: '2026-08-01T00:00:00Z' } },
        { id: JE2, fiscal_period: { is_closed: true, locked_at: null } },
        { id: 'je-open', fiscal_period: { is_closed: false, locked_at: null } },
      ],
    })

    const map = await resolveUnderlagAnchoring(supabase as unknown as SupabaseClient, COMPANY, [
      { id: 'i-a', document_id: 'doc-a', journalEntryId: JE1 },
      { id: 'i-b', document_id: 'doc-b', journalEntryId: JE2 },
      { id: 'i-c', document_id: 'doc-c', journalEntryId: 'je-open' },
      { id: 'i-d', document_id: 'doc-d', journalEntryId: JE1 },
    ])

    expect(map.get('i-a')).toEqual({ status: 'unlinked_locked', document_journal_entry_id: null })
    expect(map.get('i-b')).toEqual({ status: 'unlinked_locked', document_journal_entry_id: null })
    expect(map.get('i-c')?.status).toBe('unlinked')
    // Already anchored: the lock does not matter and it is not looked up.
    expect(map.get('i-d')?.status).toBe('anchored')
    expect(findCalls('journal_entries', 'in')).toEqual([['id', [JE1, JE2, 'je-open']]])
    // The bare `fiscal_periods(...)` embed is ambiguous on prod (fiscal_periods
    // has closing_entry_id and opening_balance_entry_id back to journal_entries)
    // and made every lock-state read fail on the first cron run (2026-08-29).
    expect(findCalls('journal_entries', 'select')).toEqual([
      ['id, fiscal_period:fiscal_periods!journal_entries_fiscal_period_id_fkey(is_closed, locked_at)'],
    ])
  })

  it('keeps an unlinked item unlinked (retryable) when the lock-state read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'doc-a', journal_entry_id: null }] })
    enqueue({ data: null, error: { message: 'boom' } })
    const map = await resolveUnderlagAnchoring(supabase as unknown as SupabaseClient, COMPANY, [
      { id: 'i-a', document_id: 'doc-a', journalEntryId: JE1 },
    ])
    expect(map.get('i-a')?.status).toBe('unlinked')
  })

  it('leaves items absent (unknown, not anchored) when the document read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    const map = await resolveUnderlagAnchoring(supabase as unknown as SupabaseClient, COMPANY, [
      { id: 'i-a', document_id: 'doc-a', journalEntryId: JE1 },
      { id: 'i-none', document_id: null, journalEntryId: JE1 },
    ])
    expect(map.has('i-a')).toBe(false)
    expect(map.get('i-none')?.status).toBe('anchored')
  })

  it('leaves an item absent when its document row is not returned', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    const map = await resolveUnderlagAnchoring(supabase as unknown as SupabaseClient, COMPANY, [
      { id: 'i-a', document_id: 'doc-a', journalEntryId: JE1 },
    ])
    expect(map.has('i-a')).toBe(false)
  })
})

describe('stampNewInboxItemIfDocumentLinked', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stamps a just-created item whose document a verifikat took meanwhile (agent feedback seq 1003926)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { journal_entry_id: JE1 } }) // the link committed while extraction ran
    enqueue({ data: [{ id: 'item-new' }] }) // stamp

    const result = await stampNewInboxItemIfDocumentLinked(supabase as unknown as SupabaseClient, COMPANY, 'doc-new')

    expect(result).toBe(JE1)
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: JE1 }]])
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['document_id', 'doc-new'])
  })

  it('leaves the item alone when no verifikat holds the document, or the read fails', async () => {
    const unlinked = createQueuedMockSupabase()
    unlinked.enqueue({ data: { journal_entry_id: null } })
    expect(
      await stampNewInboxItemIfDocumentLinked(unlinked.supabase as unknown as SupabaseClient, COMPANY, 'doc-new'),
    ).toBeNull()
    expect(unlinked.findCalls('invoice_inbox_items', 'update')).toEqual([])

    const failed = createQueuedMockSupabase()
    failed.enqueue({ data: null, error: { message: 'timeout' } })
    expect(
      await stampNewInboxItemIfDocumentLinked(failed.supabase as unknown as SupabaseClient, COMPANY, 'doc-new'),
    ).toBeNull()
    expect(failed.findCalls('invoice_inbox_items', 'update')).toEqual([])
  })
})

describe('completeInboxItemOnEntry: a receipt onto the verifikat its invoice was booked on', () => {
  const BASIS = { basis: 'user_confirmed' as const, evidence: { rule_id: 'inbox_receipt_pair:invoice_number' } }
  const RECEIPT = { id: 'receipt', document_id: 'doc-r' }
  beforeEach(() => vi.clearAllMocks())

  it('links the document, then stamps the item, nothing else', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { journal_entry_id: null } }) // the document is on no verifikat yet
    enqueue({ data: [{ id: 'receipt' }] }) // the stamp lands
    expect(await completeInboxItemOnEntry(supabase as unknown as SupabaseClient, COMPANY, RECEIPT, JE1, BASIS)).toBe('completed')
    expect(linkToJournalEntry).toHaveBeenCalledWith(supabase, COMPANY, 'doc-r', JE1, {
      link_basis: 'user_confirmed',
      link_evidence: { rule_id: 'inbox_receipt_pair:invoice_number' },
    })
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: JE1, matched_transaction_id: undefined }]])
    expect(findCalls('invoice_inbox_items', 'is')).toEqual(expect.arrayContaining([['created_journal_entry_id', null], ['created_supplier_invoice_id', null]]))
    expect(findCalls('journal_entries', 'update')).toEqual([])
  })

  it('never moves a document off another verifikat, and then stamps nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { journal_entry_id: JE2 } })
    expect(await completeInboxItemOnEntry(supabase as unknown as SupabaseClient, COMPANY, RECEIPT, JE1, BASIS)).toBe('not_linked')
    expect(linkToJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
  })

  it('a link the period lock refuses stamps nothing', async () => {
    vi.mocked(linkToJournalEntry).mockRejectedValueOnce(new Error('period is locked'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { journal_entry_id: null } })
    expect(await completeInboxItemOnEntry(supabase as unknown as SupabaseClient, COMPANY, RECEIPT, JE1, BASIS)).toBe('not_linked')
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
  })

  it('an item another verifikat already holds is taken', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { journal_entry_id: JE1 } }) // already on this verifikat: no link write
    enqueue({ data: [] }) // the stamp matched nothing
    expect(await completeInboxItemOnEntry(supabase as unknown as SupabaseClient, COMPANY, RECEIPT, JE1, BASIS)).toBe('taken')
    expect(linkToJournalEntry).not.toHaveBeenCalled()
  })
})

describe('propagateUnderlagForBookedTransaction: the receipt that came with the invoice follows it onto the row', () => {
  const reading = (documentKind: string, extra: Record<string, unknown> = {}) => ({
    documentKind,
    supplier: { name: 'X Internet Unlimited Company' },
    invoice: { invoiceNumber: 'J0LVRPBD-0003', invoiceDate: '2026-10-03', currency: 'SEK' },
    totals: { total: 83 },
    ...extra,
  })
  const row = (id: string, documentKind: string, overrides: Record<string, unknown> = {}) => ({
    id,
    status: 'received',
    source: 'email',
    document_id: `doc-${id}`,
    resend_email_id: 'mail-x',
    channel_context: null,
    kind_hint: null,
    extracted_data: reading(documentKind),
    routed_to_arkiv_at: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    ...overrides,
  })
  const invoice = row('invoice', 'supplier_invoice', { matched_transaction_id: TX1 })
  const receipt = row('receipt', 'receipt', { extracted_data: reading('receipt', { payment: { method: 'card', cardLast4: '3667' } }) })

  beforeEach(() => {
    vi.clearAllMocks()
    readDeliverySiblings.mockResolvedValue({ items: [invoice, receipt], arrivalIds: new Map() })
  })

  /** The invoice matched to the row, its document not yet on a verifikat, its stamp landing. */
  function bookedRow(enqueue: ReturnType<typeof createQueuedMockSupabase>['enqueue']) {
    enqueue({ data: { document_id: null } }) // tx pin lookup: nothing pinned
    enqueue({ data: [invoice] }) // matched items: the invoice
    enqueue({ data: { journal_entry_id: null } }) // the invoice's document, not yet anchored
    enqueue({ data: [{ id: 'invoice' }] }) // its stamp lands
  }

  it('links the receipt\'s document to the same verifikat, then stamps it and matches it to the row', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    bookedRow(enqueue)
    enqueue({ data: { journal_entry_id: null } }) // the receipt's document, not yet anchored
    enqueue({ data: [{ id: 'receipt' }] }) // its stamp lands

    await propagateUnderlagForBookedTransaction(supabase as unknown as SupabaseClient, COMPANY, TX1, JE1)

    expect(linkToJournalEntry).toHaveBeenCalledWith(expect.anything(), COMPANY, 'doc-receipt', JE1, {
      link_basis: 'system_derived',
      link_evidence: { rule_id: 'inbox_receipt_pair:invoice_number' },
    })
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([
      [{ created_journal_entry_id: JE1 }],
      [{ created_journal_entry_id: JE1, matched_transaction_id: TX1 }],
    ])
    // The delivery is read from the invoice as it stood before its stamp.
    expect(readDeliverySiblings).toHaveBeenCalledWith(expect.anything(), COMPANY, expect.objectContaining({ id: 'invoice' }))
  })

  it('leaves a receipt matched to another bank row alone: another payment', async () => {
    readDeliverySiblings.mockResolvedValue({ items: [invoice, { ...receipt, matched_transaction_id: 'tx-other' }], arrivalIds: new Map() })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    bookedRow(enqueue)
    await propagateUnderlagForBookedTransaction(supabase as unknown as SupabaseClient, COMPANY, TX1, JE1)
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: JE1 }]])
  })

  it('takes nothing along for an invoice that came alone, or a receipt that is not the same purchase', async () => {
    readDeliverySiblings.mockResolvedValueOnce({ items: [invoice], arrivalIds: new Map() })
    const alone = createQueuedMockSupabase()
    bookedRow(alone.enqueue)
    await propagateUnderlagForBookedTransaction(alone.supabase as unknown as SupabaseClient, COMPANY, TX1, JE1)
    expect(alone.findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: JE1 }]])

    readDeliverySiblings.mockResolvedValueOnce({ items: [invoice, { ...receipt, extracted_data: reading('receipt', { totals: { total: 90 } }) }], arrivalIds: new Map() })
    const other = createQueuedMockSupabase()
    bookedRow(other.enqueue)
    await propagateUnderlagForBookedTransaction(other.supabase as unknown as SupabaseClient, COMPANY, TX1, JE1)
    expect(other.findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: JE1 }]])
    expect(linkToJournalEntry).toHaveBeenCalledTimes(2) // the two invoices' own documents only
  })

  it('a receipt whose document the period lock refuses stays in the inbox, and the booking stands', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    bookedRow(enqueue)
    enqueue({ data: { journal_entry_id: 'je-elsewhere' } }) // the receipt's document is on another verifikat
    await expect(propagateUnderlagForBookedTransaction(supabase as unknown as SupabaseClient, COMPANY, TX1, JE1)).resolves.toBeUndefined()
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: JE1 }]])
  })

  it('never fails the booking when the delivery cannot be read', async () => {
    readDeliverySiblings.mockRejectedValue(new Error('boom'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    bookedRow(enqueue)
    await expect(propagateUnderlagForBookedTransaction(supabase as unknown as SupabaseClient, COMPANY, TX1, JE1)).resolves.toBeUndefined()
  })
})
