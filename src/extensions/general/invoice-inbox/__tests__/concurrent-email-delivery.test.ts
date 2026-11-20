import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// Resend redelivers a webhook that has not answered in time while the first
// run is still extracting, so two runs of one mail can meet at the inbox
// insert. These tests drive processArchivedDocument straight to that insert:
// no AI entitlement means no extraction, so the queue is the sandbox lookup,
// the insert and (on a collision) the lookup of the row that won.

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(false) }
})
vi.mock('@/lib/suppliers/match-supplier', () => ({ matchSupplierId: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/documents/inbox-extraction/mirror-extraction', () => ({ mirrorExtractionToDocument: vi.fn() }))
vi.mock('@/lib/operations/inbox-bank-match', () => ({ proposeBankMatchForInboxItem: vi.fn() }))
// No Arkiv-queued item on the document (crm#1413 takeover is tested in
// queued-item-takeover.test.ts): the door files its own row.
vi.mock('@/lib/documents/queued-inbox-item', () => ({ adoptQueuedInboxItem: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))

import { processArchivedDocument } from '@/extensions/general/invoice-inbox/lib/upload-and-extract'
import { mirrorExtractionToDocument } from '@/lib/documents/inbox-extraction/mirror-extraction'

const FILE = { name: 'kvitto.png', buffer: new ArrayBuffer(8), type: 'image/png' }
const DOC = { id: 'doc-1', mime_type: 'image/png' }
const EMAIL_META = { from: 'billing@supplier.example', resendEmailId: 'em_1', resendAttachmentId: 'att_1' }
const UNIQUE_VIOLATION = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "idx_invoice_inbox_items_company_resend_email_attachment"',
}
const FILED_ROW = {
  id: 'item-first',
  status: 'received',
  document_id: 'doc-1',
  extracted_data: { supplier: { name: null } },
  matched_supplier_id: null,
  matched_transaction_id: null,
}

function run(supabase: unknown, emailMeta: Record<string, unknown> | undefined, source: 'email' | 'upload' = 'email') {
  return processArchivedDocument(supabase as never, 'user-1', 'company-1', DOC, FILE, source, emailMeta)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('processArchivedDocument and an overlapping email delivery', () => {
  it('files the row on the first delivery', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null }) // company_settings: not a sandbox
    enqueue({ data: { id: 'item-new', status: 'received', matched_supplier_id: null, matched_transaction_id: null } })

    const result = await run(supabase, EMAIL_META)

    expect(result).toMatchObject({ inbox_item_id: 'item-new', status: 'received' })
    expect(result).not.toHaveProperty('duplicate')
    expect(findCall('invoice_inbox_items', 'insert')?.[0]).toMatchObject({
      resend_email_id: 'em_1',
      resend_attachment_id: 'att_1',
    })
    expect(mirrorExtractionToDocument).toHaveBeenCalledOnce()
  })

  it('returns the row the other delivery filed when the insert hits the delivery key', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null }) // company_settings
    enqueue({ data: null, error: UNIQUE_VIOLATION }) // the other delivery won the insert
    enqueue({ data: [FILED_ROW] }) // ... and this is its row

    const result = await run(supabase, EMAIL_META)

    expect(result).toMatchObject({
      inbox_item_id: 'item-first',
      document_id: 'doc-1',
      duplicate: true,
      skip_reason: 'duplicate_delivery',
    })
    // Looked up by exactly the key that collided, scoped to the company.
    const eqs = findCalls('invoice_inbox_items', 'eq')
    expect(eqs).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['resend_email_id', 'em_1'],
        ['resend_attachment_id', 'att_1'],
      ]),
    )
    // The winner owns the reading on the document; the loser writes nothing.
    expect(mirrorExtractionToDocument).not.toHaveBeenCalled()
  })

  it('still throws when the colliding row cannot be found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    enqueue({ data: null, error: UNIQUE_VIOLATION })
    enqueue({ data: [] })

    await expect(run(supabase, EMAIL_META)).rejects.toThrow(/^Failed to create inbox item: duplicate key/)
  })

  it('throws any other insert error without looking for a delivery', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })
    enqueue({ data: null, error: { code: '23503', message: 'insert or update violates foreign key constraint' } })

    await expect(run(supabase, EMAIL_META)).rejects.toThrow('Failed to create inbox item: insert or update violates foreign key constraint')
    expect(findCalls('invoice_inbox_items', 'limit')).toHaveLength(0)
  })

  it('throws a unique violation that carries no delivery key (web upload)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })
    enqueue({ data: null, error: UNIQUE_VIOLATION })

    await expect(run(supabase, undefined, 'upload')).rejects.toThrow(/^Failed to create inbox item/)
    expect(findCalls('invoice_inbox_items', 'limit')).toHaveLength(0)
  })
})
