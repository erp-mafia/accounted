import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// PH 225: a file the company already had joins the item that came in first.
// The upload answer says where that item stands, so the door can say so
// instead of promising a new row under Behöver dig.
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))

import {
  duplicateItemState,
  processArchivedDocument,
} from '@/extensions/general/invoice-inbox/lib/upload-and-extract'

const FILE = { name: 'kvitto.pdf', buffer: new ArrayBuffer(8), type: 'application/pdf' }
const DOC = { id: 'doc-1', mime_type: 'application/pdf', deduplicated: true }

function earlierItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-earlier',
    status: 'received',
    created_at: '2026-09-30T13:43:20Z',
    extracted_data: { documentKind: 'receipt' },
    matched_supplier_id: null,
    matched_transaction_id: null,
    kind_hint: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    routed_to_arkiv_at: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('duplicateItemState', () => {
  it('booked when a supplier invoice or a verifikat holds the item', () => {
    expect(duplicateItemState({ created_supplier_invoice_id: 'si-1', created_journal_entry_id: null })).toBe('booked')
    expect(duplicateItemState({ created_supplier_invoice_id: null, created_journal_entry_id: 'je-1' })).toBe('booked')
  })

  it('arkiv when Arkiv took it out of the inbox, inbox otherwise', () => {
    expect(
      duplicateItemState({ created_supplier_invoice_id: null, created_journal_entry_id: null, routed_to_arkiv_at: '2026-10-27T15:12:00Z' }),
    ).toBe('arkiv')
    expect(duplicateItemState({ created_supplier_invoice_id: null, created_journal_entry_id: null, routed_to_arkiv_at: null })).toBe('inbox')
  })
})

describe('processArchivedDocument for content the company already had', () => {
  it('names the booked item the upload joined and when it came in', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [earlierItem({ created_journal_entry_id: 'je-1', matched_transaction_id: 'tx-1' })] })
    enqueue({ data: { doc_type: 'receipt', admission_state: 'admitted' } }) // routing check of the deduplicated document

    const result = await processArchivedDocument(supabase as never, 'user-1', 'company-1', DOC, FILE, 'upload')

    expect(result).toMatchObject({
      inbox_item_id: 'item-earlier',
      duplicate: true,
      skip_reason: 'duplicate_content',
      duplicate_of: { received_at: '2026-09-30T13:43:20Z', state: 'booked' },
    })
    // Nothing new is filed for the second copy.
    expect(findCall('invoice_inbox_items', 'insert')).toBeUndefined()
    // The lookup reads what the answer needs.
    const columns = String(findCall('invoice_inbox_items', 'select')?.[0])
    expect(columns).toContain('created_at')
    expect(columns).toContain('routed_to_arkiv_at')
  })

  it('names an open earlier item as still in the inbox', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [earlierItem()] })
    enqueue({ data: { doc_type: 'receipt', admission_state: 'admitted' } })

    const result = await processArchivedDocument(supabase as never, 'user-1', 'company-1', DOC, FILE, 'upload')

    expect(result).toMatchObject({ duplicate_of: { state: 'inbox' } })
  })
})
