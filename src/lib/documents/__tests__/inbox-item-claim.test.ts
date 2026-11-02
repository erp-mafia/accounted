import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const reverseOrphanedJournalEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  reverseOrphanedJournalEntry: (...args: unknown[]) => reverseOrphanedJournalEntryMock(...args),
}))

import {
  claimInboxItemForEntry,
  claimInboxItemOrReverseEntry,
  readInboxItemBookingState,
} from '../inbox-item-claim'

const COMPANY = 'company-1'
const USER = 'user-1'

function client() {
  const mock = createQueuedMockSupabase()
  return { ...mock, sb: mock.supabase as unknown as SupabaseClient }
}

beforeEach(() => {
  vi.clearAllMocks()
  reverseOrphanedJournalEntryMock.mockResolvedValue(undefined)
})

describe('claimInboxItemForEntry', () => {
  it('claims an empty pointer only while no supplier invoice holds the item', async () => {
    const { sb, enqueue, findCalls } = client()
    enqueue({ data: [{ id: 'item-1' }] })

    expect(await claimInboxItemForEntry(sb, COMPANY, 'item-1', 'je-1')).toEqual({ status: 'claimed' })
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: 'je-1' }]])
    expect(findCalls('invoice_inbox_items', 'is')).toEqual([
      ['created_journal_entry_id', null],
      ['created_supplier_invoice_id', null],
    ])
  })

  it('answers taken when the compare-and-set matched no row', async () => {
    const { sb, enqueue } = client()
    enqueue({ data: [] })
    expect(await claimInboxItemForEntry(sb, COMPANY, 'item-1', 'je-1')).toEqual({ status: 'taken' })
  })

  it('compares against a stale pointer it was told to replace', async () => {
    const { sb, enqueue, findCalls } = client()
    enqueue({ data: [{ id: 'item-1' }] })
    await claimInboxItemForEntry(sb, COMPANY, 'item-1', 'je-2', { expected: 'je-reversed' })
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['created_journal_entry_id', 'je-reversed'])
    expect(findCalls('invoice_inbox_items', 'is')).toEqual([['created_supplier_invoice_id', null]])
  })
})

describe('claimInboxItemOrReverseEntry', () => {
  it('reverses nothing when the claim lands', async () => {
    const { sb, enqueue } = client()
    enqueue({ data: [{ id: 'item-1' }] })
    expect(await claimInboxItemOrReverseEntry(sb, COMPANY, USER, 'item-1', 'je-1')).toEqual({ status: 'claimed' })
    expect(reverseOrphanedJournalEntryMock).not.toHaveBeenCalled()
  })

  it('reverses its own verifikat when another booking holds the item', async () => {
    const { sb, enqueue, findCalls } = client()
    enqueue({ data: [] })
    expect(await claimInboxItemOrReverseEntry(sb, COMPANY, USER, 'item-1', 'je-1')).toEqual({ status: 'taken' })
    expect(reverseOrphanedJournalEntryMock).toHaveBeenCalledWith(sb, COMPANY, USER, 'je-1', expect.any(String))
    // Nothing to release: the row holds someone else's stamp.
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(1)
  })

  it('releases a claim that may have landed before reversing, back to the value it replaced', async () => {
    const { sb, enqueue, findCalls } = client()
    enqueue({ error: { message: 'connection reset' } })
    enqueue({ data: null })
    const claim = await claimInboxItemOrReverseEntry(sb, COMPANY, USER, 'item-1', 'je-1', { expected: 'je-old' })
    expect(claim.status).toBe('failed')
    expect(findCalls('invoice_inbox_items', 'update')[1]).toEqual([{ created_journal_entry_id: 'je-old' }])
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['created_journal_entry_id', 'je-1'])
    expect(reverseOrphanedJournalEntryMock).toHaveBeenCalledTimes(1)
  })
})

describe('readInboxItemBookingState', () => {
  it('missing item', async () => {
    const { sb, enqueue } = client()
    enqueue({ data: null })
    expect(await readInboxItemBookingState(sb, COMPANY, 'item-1')).toEqual({ state: 'missing' })
  })

  it('open item with an empty pointer reads no verifikat', async () => {
    const { sb, enqueue, findCalls } = client()
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: null } })
    expect(await readInboxItemBookingState(sb, COMPANY, 'item-1')).toEqual({ state: 'open', replaces: null })
    expect(findCalls('journal_entries', 'select')).toEqual([])
  })

  it('an open item carries its extracted underlag for the door\'s own checks', async () => {
    const { sb, enqueue } = client()
    const extracted = { invoice: { currency: 'EUR' }, totals: { total: 100 } }
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: null, extracted_data: extracted } })
    expect(await readInboxItemBookingState(sb, COMPANY, 'item-1')).toEqual({ state: 'open', replaces: null, extracted_data: extracted })
  })

  it('a supplier invoice books the item', async () => {
    const { sb, enqueue } = client()
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: 'si-1' } })
    expect(await readInboxItemBookingState(sb, COMPANY, 'item-1')).toEqual({
      state: 'booked',
      journal_entry_id: null,
      supplier_invoice_id: 'si-1',
    })
  })

  it('a live verifikat on its document books the item, stamp or not', async () => {
    const { sb, enqueue } = client()
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: null, document_hold: { journal_entry_id: 'je-held', entry: { status: 'posted' } } } })
    expect(await readInboxItemBookingState(sb, COMPANY, 'item-1')).toEqual({
      state: 'booked',
      journal_entry_id: 'je-held',
      supplier_invoice_id: null,
    })
  })

  it('a reversed verifikat on its document does not', async () => {
    const { sb, enqueue } = client()
    enqueue({ data: { created_journal_entry_id: null, created_supplier_invoice_id: null, document_hold: { journal_entry_id: 'je-gone', entry: { status: 'reversed' } } } })
    expect(await readInboxItemBookingState(sb, COMPANY, 'item-1')).toEqual({ state: 'open', replaces: null })
  })

  it('a stale pointer stays replaceable, unless a live verifikat holds the document', async () => {
    const stale = client()
    stale.enqueue({ data: { created_journal_entry_id: 'je-gone', created_supplier_invoice_id: null } })
    stale.enqueue({ data: { status: 'reversed' } })
    expect(await readInboxItemBookingState(stale.sb, COMPANY, 'item-1')).toEqual({ state: 'open', replaces: 'je-gone' })

    const held = client()
    held.enqueue({ data: { created_journal_entry_id: 'je-gone', created_supplier_invoice_id: null, document_hold: { journal_entry_id: 'je-correction', entry: { status: 'posted' } } } })
    held.enqueue({ data: { status: 'reversed' } })
    expect(await readInboxItemBookingState(held.sb, COMPANY, 'item-1')).toEqual({ state: 'booked', journal_entry_id: 'je-correction', supplier_invoice_id: null })
  })

  it('a posted verifikat books the item', async () => {
    const { sb, enqueue } = client()
    enqueue({ data: { created_journal_entry_id: 'je-1', created_supplier_invoice_id: null } })
    enqueue({ data: { status: 'posted' } })
    expect(await readInboxItemBookingState(sb, COMPANY, 'item-1')).toEqual({
      state: 'booked',
      journal_entry_id: 'je-1',
      supplier_invoice_id: null,
    })
  })

  it.each(['reversed', 'cancelled'])('a pointer at a %s verifikat is stale and replaceable', async (status) => {
    const { sb, enqueue } = client()
    enqueue({ data: { created_journal_entry_id: 'je-1', created_supplier_invoice_id: null } })
    enqueue({ data: { status } })
    expect(await readInboxItemBookingState(sb, COMPANY, 'item-1')).toEqual({ state: 'open', replaces: 'je-1' })
  })

  it('a read error is an error, never open', async () => {
    const { sb, enqueue } = client()
    enqueue({ data: { created_journal_entry_id: 'je-1', created_supplier_invoice_id: null } })
    enqueue({ error: { message: 'timeout' } })
    expect((await readInboxItemBookingState(sb, COMPANY, 'item-1')).state).toBe('error')
  })
})
