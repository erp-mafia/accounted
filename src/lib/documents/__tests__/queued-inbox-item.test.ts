import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { adoptQueuedInboxItem, type DoorInboxItemFields } from '../queued-inbox-item'

const companyId = '11111111-1111-4111-8111-111111111111'
const documentId = '33333333-3333-4333-8333-333333333333'
const queuedId = '44444444-4444-4444-8444-444444444444'

const reading = { supplier: { name: 'Synthetic Supplier' }, totals: { total: 125 } }

const mcpFields: DoorInboxItemFields = {
  status: 'received',
  source: 'upload',
  channel_context: { intake_source: 'mcp' },
  extracted_data: reading,
  extraction_skipped: false,
  matched_supplier_id: null,
  kind_hint: null,
}

/** The row Arkiv's queueing files for a classified document before the door's reading lands (route-from-arkiv.ts). */
const arkivRow = {
  id: queuedId,
  status: 'received',
  extracted_data: null,
  matched_supplier_id: null,
  matched_transaction_id: null,
  created_supplier_invoice_id: null,
  created_journal_entry_id: null,
  channel_context: { intake_source: 'partner_api' },
}

describe('adoptQueuedInboxItem (crm#1413: one document, one inbox item)', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
  })

  it('answers null when no item is on the document: the door files its own', async () => {
    mock.enqueue({ data: [] })

    const result = await adoptQueuedInboxItem(mock.supabase as never, companyId, documentId, mcpFields)

    expect(result).toBeNull()
    expect(mock.findCalls('invoice_inbox_items', 'update')).toHaveLength(0)
    expect(mock.findCalls('invoice_inbox_items', 'eq')).toEqual([
      ['company_id', companyId],
      ['document_id', documentId],
    ])
  })

  it('takes over the item Arkiv queued with the door reading and stamp, guarded on the open-item predicate', async () => {
    mock.enqueueMany([
      { data: [arkivRow] },
      { data: [{ id: queuedId, status: 'received', extracted_data: reading, matched_supplier_id: null, matched_transaction_id: null }] },
    ])

    const result = await adoptQueuedInboxItem(mock.supabase as never, companyId, documentId, mcpFields)

    expect(result).toEqual({
      id: queuedId,
      status: 'received',
      extracted_data: reading,
      matched_supplier_id: null,
      matched_transaction_id: null,
      adopted: true,
    })
    const [payload] = mock.findCall('invoice_inbox_items', 'update') as [Record<string, unknown>]
    expect(payload).toMatchObject({
      source: 'upload',
      channel_context: { intake_source: 'mcp' },
      extracted_data: reading,
      extraction_skipped: false,
      // A model's type from Arkiv never outranks the door's reader: the item reads as if the door had filed it.
      kind_hint: null,
      email_from: null,
      matched_transaction_id: null,
    })
    expect(payload).not.toHaveProperty('company_id')
    expect(payload).not.toHaveProperty('document_id')
    expect(mock.findCalls('invoice_inbox_items', 'is')).toEqual([
      ['created_supplier_invoice_id', null],
      ['created_journal_entry_id', null],
      ['matched_transaction_id', null],
    ])
  })

  it('keeps an item that was booked meanwhile as it stands and writes nothing', async () => {
    mock.enqueue({ data: [{ ...arkivRow, created_journal_entry_id: 'je-1', extracted_data: { supplier: { name: 'Booked' } } }] })

    const result = await adoptQueuedInboxItem(mock.supabase as never, companyId, documentId, mcpFields)

    expect(result).toMatchObject({ id: queuedId, adopted: false, extracted_data: { supplier: { name: 'Booked' } } })
    expect(mock.findCalls('invoice_inbox_items', 'update')).toHaveLength(0)
  })

  it('keeps the door own item from an earlier attempt, so a retry never overwrites a corrected reading', async () => {
    const corrected = { supplier: { name: 'Corrected by a person' } }
    mock.enqueue({ data: [{ ...arkivRow, extracted_data: corrected, channel_context: { intake_source: 'mcp' } }] })

    const result = await adoptQueuedInboxItem(mock.supabase as never, companyId, documentId, mcpFields, { ownStamp: 'mcp' })

    expect(result).toMatchObject({ id: queuedId, adopted: false, extracted_data: corrected })
    expect(mock.findCalls('invoice_inbox_items', 'update')).toHaveLength(0)
  })

  it('answers the item unchanged when a booking lands between the read and the guarded write', async () => {
    mock.enqueueMany([{ data: [arkivRow] }, { data: [] }])

    const result = await adoptQueuedInboxItem(mock.supabase as never, companyId, documentId, mcpFields)

    expect(result).toMatchObject({ id: queuedId, adopted: false })
  })

  it.each([
    ['the lookup fails', [{ error: { message: 'boom' } }]],
    ['the takeover write fails', [{ data: [arkivRow] }, { error: { message: 'boom' } }]],
  ])('lets the door file its own item when %s: a twin is cosmetic, a lost upload is not', async (_label, answers) => {
    mock.enqueueMany(answers)

    await expect(adoptQueuedInboxItem(mock.supabase as never, companyId, documentId, mcpFields)).resolves.toBeNull()
  })

  it('lets the door file its own item when the client throws', async () => {
    const supabase = { from: vi.fn(() => { throw new Error('network down') }) }

    await expect(adoptQueuedInboxItem(supabase as never, companyId, documentId, mcpFields)).resolves.toBeNull()
  })
})
