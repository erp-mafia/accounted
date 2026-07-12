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
import { hasLiveJournalEntryLink } from '../link-journal-entry'

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
