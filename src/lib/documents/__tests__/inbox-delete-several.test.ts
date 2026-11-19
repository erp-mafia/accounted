/**
 * Removing several inbox items is the single removal once per item
 * (deleteInboxItems over deleteInboxItem): the guard for an item that became
 * a supplier invoice or was booked holds per item, a refusal or a failure
 * never stops the rest, and only what was removed leaves a decision row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { deleteInboxItems } from '../inbox-item-actions'
import { recordInboxDecision, snapshotInboxExtraction } from '@/lib/suggestion-log/inbox'

vi.mock('@/lib/suggestion-log/inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/inbox')>()),
  snapshotInboxExtraction: vi.fn(async (_supabase: unknown, companyId: string, item: { id: string; document_id?: string | null }) => ({
    companyId,
    inboxItemId: item.id,
    documentId: item.document_id ?? null,
    extraction: null,
    model: null,
  })),
  recordInboxDecision: vi.fn(async (..._args: unknown[]) => undefined),
}))

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  document_id: `doc-${id}`,
  created_supplier_invoice_id: null,
  created_journal_entry_id: null,
  extracted_data: null,
  ...over,
})

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }

function ctx(supabase: unknown) {
  return { supabase, companyId: 'company-1', userId: 'user-1', log } as never
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('deleteInboxItems', () => {
  it('removes each open item and records each as its own dismissal', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: item('a') })
    enqueue({ data: null, error: null })
    enqueue({ data: item('b') })
    enqueue({ data: null, error: null })

    const results = await deleteInboxItems(ctx(supabase), ['a', 'b'])

    expect(results).toEqual([
      { id: 'a', removed: true },
      { id: 'b', removed: true },
    ])
    expect(vi.mocked(snapshotInboxExtraction)).toHaveBeenCalledTimes(2)
    const recorded = vi.mocked(recordInboxDecision).mock.calls.map((call) => (call[1] as { inboxItemId?: string } | null)?.inboxItemId)
    expect(recorded).toEqual(['a', 'b'])
  })

  it('refuses a booked item and one that became a supplier invoice, and still removes the others', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: item('a') })
    enqueue({ data: null, error: null })
    // Booked: one read, no delete.
    enqueue({ data: item('booked', { created_journal_entry_id: 'je-1' }) })
    // A supplier invoice: one read, no delete.
    enqueue({ data: item('converted', { created_supplier_invoice_id: 'si-1' }) })
    // Not the company's (or gone): the read finds nothing.
    enqueue({ data: null })
    enqueue({ data: item('z') })
    enqueue({ data: null, error: null })

    const results = await deleteInboxItems(ctx(supabase), ['a', 'booked', 'converted', 'missing', 'z'])

    expect(results).toEqual([
      { id: 'a', removed: true },
      { id: 'booked', removed: false, code: 'INBOX_ITEM_DELETE_BOOKED' },
      { id: 'converted', removed: false, code: 'INBOX_ITEM_DELETE_CONVERTED' },
      { id: 'missing', removed: false, code: 'INBOX_ITEM_NOT_FOUND' },
      { id: 'z', removed: true },
    ])
    // Seven reads and writes in all: the three refused items were read and never written.
    expect(supabase.from).toHaveBeenCalledTimes(7)
    expect(findCalls('invoice_inbox_items', 'delete')).toHaveLength(2)
    const recorded = vi.mocked(recordInboxDecision).mock.calls.map((call) => (call[1] as { inboxItemId?: string } | null)?.inboxItemId)
    expect(recorded).toEqual(['a', 'z'])
  })

  it('a failed delete or a thrown error is that item\'s outcome, and the next item is still removed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: item('a') })
    enqueue({ data: null, error: { message: 'boom', code: '500' } })
    enqueue({ data: item('b') })
    enqueue({ data: item('c') })
    enqueue({ data: null, error: null })
    // The first item's snapshot is the default; the second item's throws.
    const snapshot = vi.mocked(snapshotInboxExtraction)
    const usual = snapshot.getMockImplementation()!
    snapshot.mockImplementationOnce(usual).mockImplementationOnce(async () => {
      throw new Error('snapshot failed')
    })

    const results = await deleteInboxItems(ctx(supabase), ['a', 'b', 'c'])

    expect(results).toEqual([
      { id: 'a', removed: false, code: 'UNKNOWN_ERROR' },
      { id: 'b', removed: false, code: 'UNKNOWN_ERROR' },
      { id: 'c', removed: true },
    ])
    expect(log.error).toHaveBeenCalledTimes(2)
  })

  it('takes an id named twice once', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: item('a') })
    enqueue({ data: null, error: null })

    expect(await deleteInboxItems(ctx(supabase), ['a', 'a'])).toEqual([{ id: 'a', removed: true }])
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })
})
