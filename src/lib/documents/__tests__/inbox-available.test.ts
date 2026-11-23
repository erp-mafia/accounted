import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { readAvailableInboxDocs } from '../inbox-available'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const ITEM = {
  id: 'inbox-1',
  document_id: 'doc-1',
  source: 'email',
  created_at: '2026-11-20T08:00:00Z',
  extracted_data: { supplier: { name: 'Biltema' }, totals: { total: 249 }, invoice: { currency: 'SEK', invoiceDate: '2026-11-19' } },
}
const DOC = { id: 'doc-1', file_name: 'kvitto.jpg', mime_type: 'image/jpeg', file_size_bytes: 2048, journal_entry_id: null, is_current_version: true }

beforeEach(() => reset())

describe('readAvailableInboxDocs', () => {
  it('reads the one inbox item asked for, within the company', async () => {
    enqueue({ data: [ITEM] })
    enqueue({ data: [DOC] })
    const read = await readAvailableInboxDocs(client, 'company-1', { inboxItemId: 'inbox-1' })
    expect(read.error).toBeNull()
    expect(read.data).toEqual([
      expect.objectContaining({ inbox_item_id: 'inbox-1', document_id: 'doc-1', file_name: 'kvitto.jpg', supplier_name: 'Biltema', amount: 249 }),
    ])
    const filters = findCalls('invoice_inbox_items', 'eq')
    expect(filters).toContainEqual(['company_id', 'company-1'])
    expect(filters).toContainEqual(['id', 'inbox-1'])
  })

  it('reads the newest available items without an id, with no id filter', async () => {
    enqueue({ data: [ITEM] })
    enqueue({ data: [DOC] })
    await readAvailableInboxDocs(client, 'company-1')
    expect(findCalls('invoice_inbox_items', 'eq').some(([column]) => column === 'id')).toBe(false)
  })

  it('reads only open items: no supplier invoice, no verifikat, no bank row, not in Arkiv', async () => {
    enqueue({ data: [] })
    await readAvailableInboxDocs(client, 'company-1')
    const nulls = findCalls('invoice_inbox_items', 'is')
    for (const column of ['created_supplier_invoice_id', 'created_journal_entry_id', 'matched_transaction_id', 'routed_to_arkiv_at']) {
      expect(nulls).toContainEqual([column, null])
    }
  })

  it('leaves out a document pinned to a bank row', async () => {
    enqueue({ data: [ITEM, { ...ITEM, id: 'inbox-2', document_id: 'doc-2' }] })
    enqueue({ data: [DOC, { ...DOC, id: 'doc-2', file_name: 'annat.pdf' }] })
    enqueue({ data: [{ document_id: 'doc-1' }] })
    const read = await readAvailableInboxDocs(client, 'company-1')
    expect(read.data?.map((d) => d.document_id)).toEqual(['doc-2'])
    expect(findCalls('transactions', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('finds nothing when the item is taken or its document is on a verifikat', async () => {
    enqueue({ data: [ITEM] })
    enqueue({ data: [] })
    const read = await readAvailableInboxDocs(client, 'company-1', { inboxItemId: 'inbox-1' })
    expect(read.data).toEqual([])
  })

  it('names the read that failed', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    const read = await readAvailableInboxDocs(client, 'company-1')
    expect(read).toMatchObject({ data: null, stage: 'items' })
  })
})
