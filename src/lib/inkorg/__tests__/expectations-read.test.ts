import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { addMonthsIso } from '@/lib/dates/iso'
import { loadExpectations, readDocumentEvidence, readExpectationHistory } from '../expectations-read'

type Row = Record<string, unknown>

/**
 * The shared table mock, each table answering its rows narrowed by the
 * chain's `.in()` filters, so a chunked read gets the rows of its chunk.
 */
function fakeSupabase(tables: Record<string, Row[]>) {
  const resolvers = Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [
      table,
      (chainCalls: { method: string; args: unknown[] }[]) => {
        const filters = chainCalls
          .filter((c) => c.method === 'in')
          .map((c) => ({ column: c.args[0] as string, values: c.args[1] as unknown[] }))
        return { data: rows.filter((row) => filters.every((f) => f.values.includes(row[f.column]))) }
      },
    ]),
  )
  const mock = createTableMockSupabase(resolvers)
  return {
    client: mock.supabase as unknown as SupabaseClient,
    /** Args of every `method` call against `table`. */
    on: (table: string, method: string) => mock.findCalls(table, method),
    /** Every table read, in order. */
    tablesRead: () => mock.tables(),
  }
}

const COMPANY = 'company-1'
const TODAY = '2026-10-16'

describe('readExpectationHistory', () => {
  it('reads the outflows and supplier invoices of the lookback for the company, with the names of their suppliers', async () => {
    const { client, on } = fakeSupabase({
      transactions: [{ id: 'tx-1', date: '2026-10-04' }],
      supplier_invoices: [
        { id: 'si-1', supplier_id: 'sup-1' },
        { id: 'si-2', supplier_id: 'sup-1' },
      ],
      supplier_invoice_payments: [{ supplier_invoice_id: 'si-1', transaction_id: 'tx-1' }],
      suppliers: [
        { id: 'sup-1', name: 'Elbolaget Norr AB' },
        { id: 'sup-2', name: 'Någon annan AB' },
      ],
    })
    const history = await readExpectationHistory(client, COMPANY, TODAY)
    expect(history.transactions).toHaveLength(1)
    expect(history.supplierInvoices).toHaveLength(2)
    expect(history.payments).toHaveLength(1)
    // Only the suppliers the invoices name.
    expect(history.suppliers).toEqual([{ id: 'sup-1', name: 'Elbolaget Norr AB' }])

    const since = addMonthsIso(TODAY, -25)
    for (const table of ['transactions', 'supplier_invoices', 'supplier_invoice_payments', 'suppliers']) {
      expect(on(table, 'eq')).toContainEqual(['company_id', COMPANY])
      expect(on(table, 'order').length).toBeGreaterThan(0)
      expect(on(table, 'range').length).toBeGreaterThan(0)
    }
    expect(on('transactions', 'lt')).toContainEqual(['amount', 0])
    expect(on('transactions', 'eq')).toContainEqual(['is_ignored', false])
    expect(on('transactions', 'not')).toContainEqual(['is_business', 'is', false])
    expect(on('transactions', 'gte')).toContainEqual(['date', since])
    expect(on('supplier_invoices', 'eq')).toContainEqual(['is_credit_note', false])
    expect(on('supplier_invoices', 'neq')).toContainEqual(['status', 'reversed'])
    expect(on('supplier_invoices', 'gte')).toContainEqual(['invoice_date', since])
    expect(on('supplier_invoice_payments', 'not')).toContainEqual(['transaction_id', 'is', null])
  })

  it('reads no suppliers when there are no invoices', async () => {
    const { client, tablesRead } = fakeSupabase({})
    const history = await readExpectationHistory(client, COMPANY, TODAY)
    expect(history).toEqual({ transactions: [], supplierInvoices: [], suppliers: [], payments: [] })
    expect(tablesRead()).not.toContain('suppliers')
  })
})

describe('readDocumentEvidence', () => {
  it('reads the documents and their inbox items in chunks of a hundred ids', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `doc-${i}`)
    const { client, on } = fakeSupabase({
      document_attachments: ids.map((id) => ({ id, upload_source: 'email', file_name: 'kvitto.pdf', created_at: '2026-10-04T08:00:00Z' })),
      invoice_inbox_items: [{ document_id: 'doc-3', source: 'email', channel_context: null, created_at: '2026-10-04T08:00:01Z' }],
    })
    const { documents, items } = await readDocumentEvidence(client, COMPANY, ids)
    expect(documents).toHaveLength(150)
    expect(items).toHaveLength(1)
    expect(on('document_attachments', 'in').map((args) => (args[1] as string[]).length)).toEqual([100, 50])
    expect(on('invoice_inbox_items', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(on('document_attachments', 'eq')).toContainEqual(['company_id', COMPANY])
  })
})

describe('loadExpectations', () => {
  it('reads documents only for the regular counterparties it found', async () => {
    const dates = Array.from({ length: 6 }, (_, i) => addMonthsIso('2026-10-04', i - 5))
    const row = (id: string, date: string, description: string, amount: number, documentId: string) => ({
      id,
      date,
      amount,
      currency: 'SEK',
      amount_sek: null,
      exchange_rate: null,
      merchant_name: null,
      description,
      document_id: documentId,
    })
    const { client, on } = fakeSupabase({
      transactions: [
        ...dates.map((date, i) => row(`tx-${i}`, date, 'MOLNTJANSTEN', -699, `doc-${i}`)),
        // A one-off purchase with its receipt: no cadence, so its document is never read.
        row('tx-x', '2026-09-12', 'BYGGHANDELN', -2400, 'doc-x'),
      ],
      document_attachments: [
        ...dates.map((date, i) => ({ id: `doc-${i}`, upload_source: 'email', file_name: 'kvitto.pdf', created_at: `${date}T09:00:00Z` })),
        { id: 'doc-x', upload_source: 'email', file_name: 'kvitto.pdf', created_at: '2026-09-12T09:00:00Z' },
      ],
      invoice_inbox_items: dates.map((date, i) => ({ document_id: `doc-${i}`, source: 'email', channel_context: null, created_at: `${date}T09:00:01Z` })),
    })
    const [expectation, ...rest] = await loadExpectations(client, COMPANY, TODAY)
    expect(rest).toEqual([])
    // Receipts the same day as the charge: on its way for the two days' grace.
    expect(expectation).toMatchObject({ key: 'bank:molntjansten', door: 'intake_email', waitDays: 2 })
    const askedFor = on('document_attachments', 'in').flatMap((args) => args[1] as string[])
    expect(askedFor).not.toContain('doc-x')
    expect(askedFor).toHaveLength(6)
  })

  it("reads the company's portals once and lets them name a portal for a series that never had an underlag", async () => {
    const dates = Array.from({ length: 6 }, (_, i) => addMonthsIso('2026-10-02', i - 5))
    const { client, on, tablesRead } = fakeSupabase({
      transactions: dates.map((date, i) => ({
        id: `tx-${i}`,
        date,
        amount: -449,
        currency: 'SEK',
        amount_sek: null,
        exchange_rate: null,
        merchant_name: null,
        description: 'TELIA SVERIGE AB',
        document_id: null,
      })),
      company_portals: [{ id: 'p-telia', counterparty_key: 'telia sverige', vendor_name: 'Telia', url: 'https://minasidor.telia.se/foretag' }],
    })
    const [expectation, ...rest] = await loadExpectations(client, COMPANY, TODAY)
    expect(rest).toEqual([])
    expect(expectation).toMatchObject({
      key: 'bank:telia sverige',
      door: 'portal',
      portal: { vendor: 'Telia', url: 'https://minasidor.telia.se/foretag' },
    })
    expect(tablesRead().filter((t) => t === 'company_portals')).toHaveLength(1)
    expect(on('company_portals', 'eq')).toContainEqual(['company_id', COMPANY])
  })

  it('reads no documents when no counterparty bills regularly', async () => {
    const { client, tablesRead } = fakeSupabase({
      transactions: [
        { id: 'tx-1', date: '2026-10-04', amount: -10, currency: 'SEK', amount_sek: null, exchange_rate: null, merchant_name: null, description: 'KIOSKEN', document_id: 'doc-1' },
      ],
    })
    expect(await loadExpectations(client, COMPANY, TODAY)).toEqual([])
    expect(tablesRead()).not.toContain('document_attachments')
    expect(tablesRead()).not.toContain('invoice_inbox_items')
  })
})
