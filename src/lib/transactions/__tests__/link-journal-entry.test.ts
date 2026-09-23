/**
 * Unit tests for hasLiveJournalEntryLink.
 *
 * This is the predicate the re-booking guards (linkTransactionToJournalEntry,
 * manualLink, categorize-core, the MCP stage-check) share to decide whether a
 * transaction's journal_entry_id is a LIVE link that should block re-linking,
 * or a stale pointer at a reversed/cancelled entry that the UI already shows as
 * "utan koppling" and must stay re-linkable (issue #988).
 *
 * The end-to-end re-link behaviour is covered by the route test
 * (app/api/transactions/[id]/link-journal-entry/__tests__/route.test.ts) and
 * the pending-op commit test.
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { hasLiveJournalEntryLink, linkTransactionToJournalEntry } from '../link-journal-entry'

describe('hasLiveJournalEntryLink', () => {
  it('returns false for a null/undefined pointer without querying', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', null)).toBe(false)
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', undefined)).toBe(false)
  })

  it('returns true when the entry is posted (a live link)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'posted' }, error: null })
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', 'je-1')).toBe(true)
  })

  it('returns false when the entry is reversed (stale link, #988)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'reversed' }, error: null })
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', 'je-1')).toBe(false)
  })

  it('returns false when the entry is cancelled', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'cancelled' }, error: null })
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', 'je-1')).toBe(false)
  })

  it('returns false when the referenced entry row is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', 'je-gone')).toBe(false)
  })

  it('fails closed (returns true) on a read error so a live link is never clobbered', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'statement timeout' } })
    expect(await hasLiveJournalEntryLink(supabase as never, 'company-1', 'je-1')).toBe(true)
  })
})

describe('linkTransactionToJournalEntry: junction-row guard (#1553)', () => {
  const base = {
    id: 'tx-1',
    date: '2026-06-11',
    amount: -800,
    currency: 'SEK',
    exchange_rate: null,
    journal_entry_id: null,
    invoice_id: null,
    is_business: null,
    potential_invoice_id: null,
    potential_supplier_invoice_id: null,
  }

  it('refuses a transaction anchored through a bank_line junction row (1:N split, bulk-book) even though the pointer is NULL', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: { ...base, transaction_voucher_links: [{ journal_entry_id: 'je-split-a', role: 'bank_line' }] },
      error: null,
    })

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: 'tx-1',
      journalEntryId: 'je-other',
    })

    expect(outcome).toEqual({
      ok: false,
      code: 'LINK_TX_TX_ALREADY_LINKED',
      details: { existingJournalEntryId: 'je-split-a' },
    })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('lets a residual booking\'s "other" row through: the row must stay re-linkable after a storno of its main verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { ...base, transaction_voucher_links: [{ journal_entry_id: 'je-residual', role: 'other' }] },
      error: null,
    })
    enqueue({ data: null, error: { message: 'not found' } }) // the verifikat lookup that follows the guard

    const outcome = await linkTransactionToJournalEntry(supabase as never, 'user-1', 'company-1', {
      transactionId: 'tx-1',
      journalEntryId: 'je-other',
    })

    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).not.toBe('LINK_TX_TX_ALREADY_LINKED')
    expect(supabase.from).toHaveBeenCalledWith('journal_entries')
  })
})
