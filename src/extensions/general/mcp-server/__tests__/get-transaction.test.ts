import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { TRANSACTION_DETAIL_COLUMNS } from '@/lib/transactions/detail-columns'

const companyId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const txId = '33333333-3333-4333-8333-333333333333'
const jeId = '44444444-4444-4444-8444-444444444444'
const bulkJeId = '44444444-4444-4444-8444-444444444445'
const pinnedDocId = '55555555-5555-4555-8555-555555555555'
const voucherDocId = '55555555-5555-4555-8555-555555555556'

const tool = tools.find((t) => t.name === 'gnubok_get_transaction')!

const TX_ROW = {
  is_booked: true,
  id: txId,
  date: '2026-10-03',
  description: 'BG 5050-1055',
  amount: '-125.00',
  currency: 'SEK',
  amount_sek: '-125.00',
  reference: '1001',
  merchant_name: null,
  counterparty_account: null,
  counterparty_iban: null,
  counterparty_org_number: null,
  instructed_amount: null,
  instructed_currency: null,
  balance_after: '4875.00',
  is_enriched: null,
  is_business: true,
  category: 'uncategorized',
  is_ignored: false,
  external_id: 'eb_8f2c1a',
  import_source: 'bank_feed',
  reconciliation_method: null,
  cash_account_id: null,
  invoice_id: null,
  supplier_invoice_id: null,
  potential_invoice_id: null,
  potential_match_method: null,
  journal_entry_id: jeId,
  document_id: pinnedDocId,
  receipt_id: null,
  created_at: '2026-10-03T08:00:00Z',
  updated_at: '2026-10-03T09:00:00Z',
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

  it('returns every field the v1 detail endpoint returns, read through the same column list (crm#1347)', async () => {
    const { client, calls } = db({
      transactions: { data: { ...TX_ROW, import_source: 'stripe', external_id: 'stripe_acct_1_txn_1_fee' } },
    })
    const result = await call({ transaction_id: txId }, client)

    const select = calls.find((c) => c.table === 'transactions' && c.method === 'select')
    expect(select?.args[0]).toBe(`${TRANSACTION_DETAIL_COLUMNS}, is_ignored, is_booked`)
    const v1Fields = TRANSACTION_DETAIL_COLUMNS.split(',').map((c) => c.trim()).map((c) => (c === 'id' ? 'transaction_id' : c))
    for (const field of v1Fields) expect(result, field).toHaveProperty(field)
    expect(result).not.toHaveProperty('id')
    expect(result).toMatchObject({ external_id: 'stripe_acct_1_txn_1_fee', import_source: 'stripe', balance_after: 4875 })
    expect((tool.outputSchema as { properties: Record<string, unknown> }).properties.external_id).toEqual({ type: ['string', 'null'] })
  })

  it('names the counterparty by IBAN and the original currency when the bank sent them (PH 196)', async () => {
    const { client, calls } = db({
      transactions: {
        data: { ...TX_ROW, description: 'UTLANDSBETALNING', merchant_name: 'UTLANDSBETALNING', counterparty_iban: 'NO9386011117947', instructed_amount: '-4800.00', instructed_currency: 'NOK' },
      },
    })
    const result = await call({ transaction_id: txId }, client)

    const select = calls.find((c) => c.table === 'transactions' && c.method === 'select')
    expect(String(select?.args[0]).split(',').map((c) => c.trim())).toContain('counterparty_iban')
    expect(result).toMatchObject({ counterparty_iban: 'NO9386011117947', instructed_amount: -4800, instructed_currency: 'NOK' })
  })

  it('answers null for a row the bank sent no IBAN or other currency for', async () => {
    const { client } = db()
    const result = await call({ transaction_id: txId }, client)
    expect(result).toMatchObject({ counterparty_iban: null, instructed_amount: null, instructed_currency: null })
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
    const { client, tables } = db({ transactions: { data: { ...TX_ROW, journal_entry_id: null, is_booked: false } } })
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
