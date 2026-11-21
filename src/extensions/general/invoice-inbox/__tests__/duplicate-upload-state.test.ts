import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
import { appendProcessingHistory } from '@/lib/processing-history/append'

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

// crm#1954: a person's upload in Underlag that Arkiv took (typed "other") was uploaded again, byte for byte, and the
// answer pointed at Arkiv. The person filed it to be handled in Underlag, so the re-upload brings it back.
describe("a person's re-upload of their own upload that Arkiv took", () => {
  const UPLOADED = { ...DOC, upload_source: 'file_upload' }
  const ROUTED_AT = '2026-11-20T08:07:00Z'
  const routedUpload = (overrides: Record<string, unknown> = {}) =>
    earlierItem({ source: 'upload', channel_context: null, routed_to_arkiv_at: ROUTED_AT, extracted_data: { documentKind: 'other' }, ...overrides })
  const savedSection = process.env.ARKIV_COMPANY_IDS
  // company-1 sees the Dokument section, so the replayed routing could take the item out again.
  beforeEach(() => {
    process.env.ARKIV_COMPANY_IDS = 'company-1'
  })
  afterEach(() => {
    if (savedSection === undefined) delete process.env.ARKIV_COMPANY_IDS
    else process.env.ARKIV_COMPANY_IDS = savedSection
  })

  it('brings the item back to Underlag and says it is there, and the routing leaves it (reported case)', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [routedUpload()] })
    enqueue({ data: [{ id: 'item-earlier' }] }) // the guarded requeue
    enqueue({ data: { doc_type: 'other', admission_state: 'admitted' } }) // routing check of the deduplicated document
    enqueue({ data: { id: 'doc-1', user_id: 'user-1', journal_entry_id: null, extracted_data: { documentKind: 'other' }, upload_source: 'file_upload' } })
    enqueue({ data: [routedUpload({ routed_to_arkiv_at: null })] })

    const result = await processArchivedDocument(supabase as never, 'user-1', 'company-1', UPLOADED, FILE, 'upload', undefined, null, { deferExtraction: true })

    expect(result).toMatchObject({ inbox_item_id: 'item-earlier', duplicate: true, duplicate_of: { state: 'inbox' } })
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ routed_to_arkiv_at: null, routed_doc_type: null })
    // Guarded on the open-item predicate: a booking or a match since wins.
    expect(findCalls('invoice_inbox_items', 'is')).toEqual(
      expect.arrayContaining([
        ['created_supplier_invoice_id', null],
        ['created_journal_entry_id', null],
        ['matched_transaction_id', null],
      ]),
    )
    // The routing replayed for the deduplicated document does not take it out again, and nothing new is filed.
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(1)
    expect(findCall('invoice_inbox_items', 'insert')).toBeUndefined()
    const history = vi.mocked(appendProcessingHistory).mock.calls[0]?.[0] as { payload: Record<string, unknown> }
    expect(history.payload).toMatchObject({ reason: 'duplicate_content', requeued_from_arkiv: true })
  })

  it('keeps answering Arkiv when the item was booked or matched between the read and the write', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [routedUpload()] })
    enqueue({ data: [] }) // the guard refused the write
    enqueue({ data: { doc_type: 'receipt', admission_state: 'admitted' } })

    const result = await processArchivedDocument(supabase as never, 'user-1', 'company-1', UPLOADED, FILE, 'upload')

    expect(result).toMatchObject({ duplicate_of: { state: 'arkiv' } })
    const history = vi.mocked(appendProcessingHistory).mock.calls[0]?.[0] as { payload: Record<string, unknown> }
    expect(history.payload).toMatchObject({ requeued_from_arkiv: false })
  })

  it.each([
    ['booked', { created_journal_entry_id: 'je-1' }, 'booked'],
    ['matched to a bank row', { matched_transaction_id: 'tx-1' }, 'arkiv'],
  ])('leaves an item %s as it stands', async (_label, overrides, state) => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [routedUpload(overrides)] })
    enqueue({ data: { doc_type: 'receipt', admission_state: 'admitted' } })

    const result = await processArchivedDocument(supabase as never, 'user-1', 'company-1', UPLOADED, FILE, 'upload')

    expect(result).toMatchObject({ duplicate_of: { state } })
    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('does not bring back an item that came through another door, nor for a delivery that is not a person', async () => {
    // An agreement that arrived by e-mail stays in Arkiv: the routing would take it out again.
    const mailed = createQueuedMockSupabase()
    mailed.enqueue({ data: [routedUpload({ source: 'email' })] })
    mailed.enqueue({ data: { doc_type: 'receipt', admission_state: 'admitted' } })
    const fromMail = await processArchivedDocument(mailed.supabase as never, 'user-1', 'company-1', { ...DOC, upload_source: 'email' }, FILE, 'upload')
    expect(fromMail).toMatchObject({ duplicate_of: { state: 'arkiv' } })
    expect(mailed.findCall('invoice_inbox_items', 'update')).toBeUndefined()

    // A partner delivery of the same bytes is not a person in Underlag.
    const partner = createQueuedMockSupabase()
    partner.enqueue({ data: [routedUpload()] })
    partner.enqueue({ data: { doc_type: 'receipt', admission_state: 'admitted' } })
    const fromPartner = await processArchivedDocument(partner.supabase as never, 'user-1', 'company-1', UPLOADED, FILE, 'upload', undefined, null, {
      channelContext: { channel: 'partner_api', intake_source: 'partner_api' },
    })
    expect(fromPartner).toMatchObject({ duplicate_of: { state: 'arkiv' } })
    expect(partner.findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })
})
