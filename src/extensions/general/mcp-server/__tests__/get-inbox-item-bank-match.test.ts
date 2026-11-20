import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { bankMatchSourceKey, type BankMatchItemRow } from '@/lib/documents/inbox-bank-match'
import { tools } from '../server'

/**
 * gnubok_get_inbox_item returns bank_match (match on arrival): the bank row
 * the item looks already paid by, re-checked on the read, a proposal and
 * never a booking. Undeclared like the reading, so tools/list pays nothing.
 */
const get = tools.find((candidate) => candidate.name === 'gnubok_get_inbox_item')!

const ITEM_ID = '11111111-1111-4111-8111-111111111111'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const TX_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

const READING = {
  documentKind: 'supplier_invoice',
  supplier: { name: 'Kontorsbolaget AB' },
  invoice: { invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'SEK', paymentReference: '4711000123' },
  totals: { total: 1250 },
}

function itemRow(overrides: Record<string, unknown> = {}) {
  const row = {
    id: ITEM_ID,
    company_id: 'company-1',
    status: 'received',
    source: 'upload',
    document_id: DOC_ID,
    extracted_data: READING,
    extraction_skipped: false,
    kind_hint: null,
    channel_context: null,
    matched_supplier_id: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    routed_to_arkiv_at: null,
    email_from: null,
    email_received_at: null,
    bank_match_transaction_id: TX_ID,
    bank_match_basis: 'rule_amount_date',
    bank_match_evidence_level: 'trolig',
    document_attachments: { id: DOC_ID, file_name: 'faktura.pdf', mime_type: 'application/pdf', upload_source: 'file_upload' },
    ...overrides,
  }
  return { ...row, bank_match_source_key: bankMatchSourceKey(row as BankMatchItemRow) }
}

const bankRow = {
  id: TX_ID,
  date: '2026-09-25',
  amount: -1250,
  currency: 'SEK',
  description: 'Kontorsbolaget',
  merchant_name: null,
  journal_entry_id: null,
  is_ignored: false,
  transaction_voucher_links: [],
}

/** The item by id, every other read of the table (arrivals, pairings) empty. */
function inboxItems(item: unknown): TableMockResolver {
  return (calls) => (calls.some((c) => c.method === 'single' || c.method === 'maybeSingle') ? { data: item } : { data: [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('gnubok_get_inbox_item bank_match', () => {
  it('keeps its schemas as they were: nothing new in tools/list', () => {
    expect(get.outputSchema).toEqual({ type: 'object' })
    expect(Object.keys((get.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(['inbox_item_id'])
  })

  it('returns the proposal with the bank row as it stands', async () => {
    const { supabase } = createTableMockSupabase({ invoice_inbox_items: inboxItems(itemRow()), transactions: { data: bankRow } })
    const result = (await get.execute({ inbox_item_id: ITEM_ID }, 'company-1', 'user-1', supabase as never)) as Record<string, unknown>
    expect(result.bank_match).toEqual({
      transaction_id: TX_ID,
      date: '2026-09-25',
      amount: -1250,
      currency: 'SEK',
      counterparty: 'Kontorsbolaget',
      basis: 'rule_amount_date',
      evidence_level: 'trolig',
    })
  })

  it('null once the bank row is booked, and null rather than an error when it cannot be read', async () => {
    const booked = createTableMockSupabase({ invoice_inbox_items: inboxItems(itemRow()), transactions: { data: { ...bankRow, journal_entry_id: 'je-1' } } })
    expect(((await get.execute({ inbox_item_id: ITEM_ID }, 'company-1', 'user-1', booked.supabase as never)) as Record<string, unknown>).bank_match).toBeNull()

    const failing = createTableMockSupabase({ invoice_inbox_items: inboxItems(itemRow()), transactions: { error: { message: 'timeout' } } })
    const result = (await get.execute({ inbox_item_id: ITEM_ID }, 'company-1', 'user-1', failing.supabase as never)) as Record<string, unknown>
    expect(result.id).toBe(ITEM_ID)
    expect(result.bank_match).toBeNull()
  })
})
