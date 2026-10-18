import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'

const companyId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const txId = '33333333-3333-4333-8333-333333333333'
const jeId = '44444444-4444-4444-8444-444444444444'
const bulkJeId = '44444444-4444-4444-8444-444444444445'
const pinnedDocId = '55555555-5555-4555-8555-555555555555'
const voucherDocId = '55555555-5555-4555-8555-555555555556'

const tool = tools.find((t) => t.name === 'gnubok_get_transaction')!

const TX_ROW = {
  id: txId,
  date: '2026-10-03',
  description: 'BG 5050-1055',
  amount: '-125.00',
  currency: 'SEK',
  amount_sek: '-125.00',
  reference: '1001',
  merchant_name: null,
  counterparty_account: null,
  counterparty_org_number: null,
  is_business: true,
  category: 'uncategorized',
  is_ignored: false,
  import_source: 'bank_feed',
  cash_account_id: null,
  invoice_id: null,
  supplier_invoice_id: null,
  journal_entry_id: jeId,
  document_id: pinnedDocId,
}

const ENTRY = (id: string, number: number) => ({
  id,
  voucher_series: 'A',
  voucher_number: number,
  entry_date: '2026-10-03',
  status: 'posted',
  description: 'Leverantörsbetalning',
  source_type: 'bank_transaction',
  journal_entry_lines: [
    { account_number: '1930', debit_amount: 0, credit_amount: '125.00', line_description: null, sort_order: 1 },
    { account_number: '2440', debit_amount: '125.00', credit_amount: 0, line_description: 'Faktura 1001', sort_order: 0 },
  ],
})

const docsResolver: TableMockResolver = (calls) =>
  calls.some((c) => c.method === 'in' && c.args[0] === 'journal_entry_id')
    ? { data: [{ id: voucherDocId, file_name: 'faktura-1001.pdf', mime_type: 'application/pdf', doc_type: 'supplier_invoice', page_count: 1, journal_entry_id: jeId }, { id: pinnedDocId, file_name: 'kvitto.jpg', mime_type: 'image/jpeg', doc_type: 'receipt', page_count: 1, journal_entry_id: jeId }] }
    : { data: [{ id: pinnedDocId, file_name: 'kvitto.jpg', mime_type: 'image/jpeg', doc_type: 'receipt', page_count: 1, journal_entry_id: jeId }] }

function db(tables: Parameters<typeof createTableMockSupabase>[0] = {}) {
  const mock = createTableMockSupabase({
    transactions: { data: TX_ROW },
    journal_entries: { data: [ENTRY(jeId, 17)] },
    document_attachments: docsResolver,
    ...tables,
  })
  return { ...mock, client: mock.supabase as unknown as SupabaseClient }
}

const call = (args: Record<string, unknown>, client: SupabaseClient) =>
  tool.execute(args, companyId, userId, client) as Promise<Record<string, unknown>>

describe('gnubok_get_transaction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is a search-only read with the transactions:read scope', () => {
    expect(tool.catalogVisibility).toBe('search')
    expect(tool.annotations.readOnlyHint).toBe(true)
    expect(TOOL_SCOPE_MAP.gnubok_get_transaction).toBe('transactions:read')
  })

  it('reads a booked transaction with its verifikat, lines and every document, scoped to the company', async () => {
    const { client, calls } = db()
    const result = await call({ transaction_id: txId }, client)

    expect(result).toMatchObject({
      transaction_id: txId,
      amount: -125,
      category: null,
      booked: true,
      journal_entry_id: jeId,
      verifikat: [
        {
          journal_entry_id: jeId,
          voucher: 'A17',
          status: 'posted',
          anchored_by: ['pointer'],
          lines: [
            { account_number: '2440', debit_amount: 125, credit_amount: 0, line_description: 'Faktura 1001' },
            { account_number: '1930', debit_amount: 0, credit_amount: 125, line_description: null },
          ],
        },
      ],
    })
    expect(result.documents).toEqual([
      { document_id: pinnedDocId, file_name: 'kvitto.jpg', mime_type: 'image/jpeg', doc_type: 'receipt', page_count: 1, journal_entry_id: jeId, pinned_to_transaction: true },
      { document_id: voucherDocId, file_name: 'faktura-1001.pdf', mime_type: 'application/pdf', doc_type: 'supplier_invoice', page_count: 1, journal_entry_id: jeId, pinned_to_transaction: false },
    ])
    for (const table of ['transactions', 'transaction_voucher_links', 'invoice_payments', 'supplier_invoice_payments', 'journal_entries', 'document_attachments']) {
      const scoped = calls.filter((c) => c.table === table && c.method === 'eq' && c.args[0] === 'company_id')
      expect(scoped.length, `${table} filtered by company_id`).toBeGreaterThan(0)
      expect(scoped.every((c) => c.args[1] === companyId)).toBe(true)
    }
  })

  it('finds the verifikat of a bulk-booked row that has no pointer of its own', async () => {
    const { client } = db({
      transactions: { data: { ...TX_ROW, journal_entry_id: null, document_id: null } },
      transaction_voucher_links: { data: [{ journal_entry_id: bulkJeId, role: 'bank_line' }] },
      journal_entries: { data: [ENTRY(bulkJeId, 18)] },
      document_attachments: { data: [] },
    })
    const result = await call({ transaction_id: txId }, client)
    expect(result).toMatchObject({ booked: true, journal_entry_id: null, verifikat: [{ journal_entry_id: bulkJeId, voucher: 'A18', anchored_by: ['bank_line'] }] })
  })

  it('reads an unbooked transaction with its pinned document and no verifikat', async () => {
    const { client, tables } = db({ transactions: { data: { ...TX_ROW, journal_entry_id: null } } })
    const result = await call({ transaction_id: txId }, client)
    expect(result).toMatchObject({ booked: false, verifikat: [], documents: [{ document_id: pinnedDocId, pinned_to_transaction: true }] })
    expect(tables()).not.toContain('journal_entries')
  })

  it('NOT_FOUND for an id outside the company and for a non-UUID, without a query for the latter', async () => {
    const missing = db({ transactions: { data: null } })
    await expect(call({ transaction_id: txId }, missing.client)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining(txId) })

    const garbage = db()
    await expect(call({ transaction_id: 'BG 5050' }, garbage.client)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(garbage.tables()).toEqual([])
  })

  it('fails when an anchor cannot be read, never answering "not booked"', async () => {
    const { client } = db({
      transactions: { data: { ...TX_ROW, journal_entry_id: null } },
      transaction_voucher_links: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    })
    await expect(call({ transaction_id: txId }, client)).rejects.toMatchObject({ code: '57014' })
  })
})
