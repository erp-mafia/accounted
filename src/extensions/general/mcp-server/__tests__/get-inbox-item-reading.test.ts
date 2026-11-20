import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createTableMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

/**
 * gnubok_get_inbox_item returns the one reading (lib/documents/reading)
 * beside the row it always returned. The field is undeclared: the tool's
 * schemas are unchanged, so tools/list pays nothing for it.
 */
const get = tools.find((candidate) => candidate.name === 'gnubok_get_inbox_item')!

const ITEM_ID = '11111111-1111-4111-8111-111111111111'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const MODEL = 'claude-sonnet-4-6'

const MODEL_READING = {
  documentKind: 'receipt',
  supplier: { name: 'Kafé Exempel', orgNumber: null, vatNumber: null },
  invoice: { invoiceNumber: 'K-42', invoiceDate: '2026-10-02', currency: 'SEK' },
  totals: { total: 148 },
  lineItems: [],
  vatBreakdown: [],
  confidence: 1,
}

function itemRow(extracted: Record<string, unknown>) {
  return {
    id: ITEM_ID,
    company_id: 'company-1',
    status: 'received',
    source: 'upload',
    document_id: DOC_ID,
    extracted_data: extracted,
    extraction_skipped: false,
    kind_hint: null,
    channel_context: null,
    matched_supplier_id: null,
    email_from: null,
    email_received_at: null,
    document_attachments: { id: DOC_ID, file_name: 'kvitto.jpg', mime_type: 'image/jpeg', upload_source: 'file_upload' },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('gnubok_get_inbox_item reading', () => {
  it('keeps its schemas as they were: nothing new in tools/list', () => {
    expect(get.outputSchema).toEqual({ type: 'object' })
    expect(Object.keys((get.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(['inbox_item_id'])
  })

  it("returns the reading with each field's source and evidence, a person's correction as Ditt val", async () => {
    // Keyed by table, not by call order: the tool reads more beside the reading.
    const corrected = { ...MODEL_READING, invoice: { ...MODEL_READING.invoice, invoiceDate: '2026-10-03' } }
    const { supabase, findCall } = createTableMockSupabase({
      invoice_inbox_items: { data: itemRow(corrected), error: null },
      document_attachments: {
        data: {
        id: DOC_ID,
        mime_type: 'image/jpeg',
        upload_source: 'file_upload',
        extracted_data: corrected,
        extraction_model: MODEL,
        extracted_at: '2026-10-02T10:00:00.000Z',
        model_reading: { extracted_data: MODEL_READING, extraction_model: MODEL, extracted_at: '2026-10-02T10:00:00.000Z' },
        },
        error: null,
      },
    })
    const result = (await get.execute({ inbox_item_id: ITEM_ID }, 'company-1', 'user-1', supabase as never)) as Record<string, unknown>
    expect(findCall('document_attachments', 'select')?.[0]).toBe('*')
    expect(result.extracted_data).toEqual(corrected)
    expect(result.reading).toMatchObject({
      inbox_item_id: ITEM_ID,
      document_id: DOC_ID,
      fields: {
        seller_name: { value: 'Kafé Exempel', source: 'vision', evidence: 'trolig' },
        invoice_issue_date: { value: '2026-10-03', source: 'person', evidence: 'ditt_val' },
        amount_due_for_payment: { value: 148, source: 'vision' },
      },
      door: { intake_source: 'upload' },
      notes: [],
    })
  })

  it('answers the item with a null reading when the reading cannot be read', async () => {
    const { supabase } = createTableMockSupabase({
      invoice_inbox_items: { data: itemRow(MODEL_READING), error: null },
      document_attachments: { data: null, error: { message: 'statement timeout' } },
    })
    const result = (await get.execute({ inbox_item_id: ITEM_ID }, 'company-1', 'user-1', supabase as never)) as Record<string, unknown>
    expect(result.id).toBe(ITEM_ID)
    expect(result.reading).toBeNull()
  })
})
