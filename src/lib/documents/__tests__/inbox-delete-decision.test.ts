/**
 * Deleting an inbox item dismisses the model's reading of its underlag:
 * deleteInboxItem records it in suggestion_log after the delete went
 * through, with the item's whole row so it can be put back, and records
 * nothing when the delete is refused or a dry run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { deleteInboxItem } from '../inbox-item-actions'
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
  recordInboxDecision: vi.fn(async () => undefined),
}))

const ITEM = {
  id: 'item-1',
  document_id: 'doc-1',
  created_supplier_invoice_id: null,
  created_journal_entry_id: null,
  extracted_data: null,
  email_from: 'faktura@example.test',
  email_body_text: 'Hej, här kommer fakturan.',
  created_at: '2026-10-28T08:15:00.000Z',
}

function ctx(supabase: unknown) {
  return { supabase, companyId: 'company-1', userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } } as never
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('deleteInboxItem: suggestion_log', () => {
  it('records the deletion as a dismissal after the item is gone, keeping the whole row it deleted', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: ITEM })
    enqueue({ data: null, error: null })

    const outcome = await deleteInboxItem(ctx(supabase), 'item-1')

    expect(outcome).toMatchObject({ ok: true })
    // Every column: what is not read here cannot be put back.
    expect(findCall('invoice_inbox_items', 'select')).toEqual(['*'])
    expect(vi.mocked(snapshotInboxExtraction)).toHaveBeenCalledWith(supabase, 'company-1', ITEM)
    expect(vi.mocked(recordInboxDecision)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ inboxItemId: 'item-1', documentId: 'doc-1' }),
      null,
      'user-1',
      [{ id: 'already_booked', result: 'pass', detail: null }],
      ITEM,
    )
  })

  it('records nothing when the delete fails, is refused, or is a dry run', async () => {
    const failing = createQueuedMockSupabase()
    failing.enqueue({ data: ITEM })
    failing.enqueue({ data: null, error: { message: 'boom', code: '500' } })
    await deleteInboxItem(ctx(failing.supabase), 'item-1')

    const booked = createQueuedMockSupabase()
    booked.enqueue({ data: { ...ITEM, created_journal_entry_id: 'je-1' } })
    await deleteInboxItem(ctx(booked.supabase), 'item-1')

    const dry = createQueuedMockSupabase()
    dry.enqueue({ data: ITEM })
    await deleteInboxItem(ctx(dry.supabase), 'item-1', { dryRun: true })

    expect(vi.mocked(recordInboxDecision)).not.toHaveBeenCalled()
  })
})
