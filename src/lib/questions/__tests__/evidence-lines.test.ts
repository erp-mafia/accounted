import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const balanceMock = vi.fn()
vi.mock('@/lib/bookkeeping/account-balance', () => ({
  accountBalanceThrough: (...args: unknown[]) => balanceMock(...args),
}))

import { evidenceLines } from '../evidence-lines'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const TX = '10000000-0000-4000-8000-000000000001'
const TX_GONE = '10000000-0000-4000-8000-000000000009'
const ENTRY = '20000000-0000-4000-8000-000000000001'
const INVOICE = '30000000-0000-4000-8000-000000000001'
const SUPPLIER_INVOICE = '40000000-0000-4000-8000-000000000001'
const DOCUMENT = '50000000-0000-4000-8000-000000000001'
const FACT = '60000000-0000-4000-8000-000000000001'

describe('evidenceLines', () => {
  beforeEach(() => {
    balanceMock.mockReset()
  })

  it('reads one line per reference, in the order given, with date, name, amount and link', async () => {
    balanceMock.mockResolvedValue(316000.5)
    const mock = createTableMockSupabase({
      transactions: { data: [{ id: TX, date: '2026-11-03', description: 'KORTKOP 1234', merchant_name: 'Leverantören AB', amount: -4990, currency: 'SEK' }] },
      journal_entries: { data: [{ id: ENTRY, voucher_series: 'a', voucher_number: 373, entry_date: '2026-04-27', description: 'Avgift' }] },
      journal_entry_lines: {
        data: [
          { id: 'l1', journal_entry_id: ENTRY, debit_amount: '625.00' },
          { id: 'l2', journal_entry_id: ENTRY, debit_amount: 0 },
        ],
      },
      invoices: { data: [{ id: INVOICE, invoice_number: '2026-014', invoice_date: '2026-10-01', total: 12500, currency: 'EUR', customer: { name: 'Kunden AB' } }] },
      supplier_invoices: {
        data: [{ id: SUPPLIER_INVOICE, supplier_invoice_number: 'F-88', invoice_date: '2026-10-05', total: '1250.50', currency: 'SEK', supplier: [{ name: 'Säljaren AB' }] }],
      },
      document_attachments: { data: [{ id: DOCUMENT, file_name: 'avtal.pdf', created_at: '2026-09-22T07:12:00.000Z' }] },
      agent_memory: { data: [{ id: FACT, content: 'Hyran betalas kvartalsvis.', created_at: '2026-08-05T10:00:00.000Z' }] },
      chart_of_accounts: { data: [{ account_number: '1580', account_name: 'Fordringar för kontokort' }] },
    })

    const [lines] = await evidenceLines(mock.supabase as never, COMPANY, [
      [
        { kind: 'transaction', id: TX },
        { kind: 'journal_entry', id: ENTRY },
        { kind: 'invoice', id: INVOICE },
        { kind: 'supplier_invoice', id: SUPPLIER_INVOICE },
        { kind: 'document', id: DOCUMENT },
        { kind: 'fact', id: FACT },
        { kind: 'account', id: '1580' },
      ],
    ])

    expect(lines).toEqual([
      { kind: 'transaction', id: TX, found: true, date: '2026-11-03', label: 'Leverantören AB', detail: null, amount: -4990, currency: 'SEK', href: `/transactions?highlight=${TX}` },
      { kind: 'journal_entry', id: ENTRY, found: true, date: '2026-04-27', label: 'A373', detail: 'Avgift', amount: 625, currency: 'SEK', href: `/bookkeeping/${ENTRY}` },
      { kind: 'invoice', id: INVOICE, found: true, date: '2026-10-01', label: 'Kunden AB', detail: '2026-014', amount: 12500, currency: 'EUR', href: `/invoices/${INVOICE}` },
      { kind: 'supplier_invoice', id: SUPPLIER_INVOICE, found: true, date: '2026-10-05', label: 'Säljaren AB', detail: 'F-88', amount: 1250.5, currency: 'SEK', href: `/supplier-invoices/${SUPPLIER_INVOICE}` },
      { kind: 'document', id: DOCUMENT, found: true, date: '2026-09-22', label: 'avtal.pdf', detail: null, amount: null, currency: null, href: `/api/documents/${DOCUMENT}/inline` },
      { kind: 'fact', id: FACT, found: true, date: '2026-08-05', label: 'Hyran betalas kvartalsvis.', detail: null, amount: null, currency: null, href: null },
      expect.objectContaining({ kind: 'account', id: '1580', found: true, label: '1580', detail: 'Fordringar för kontokort', amount: 316000.5, currency: 'SEK', href: null }),
    ])
    expect(balanceMock).toHaveBeenCalledWith(mock.supabase, COMPANY, '1580', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
  })

  it('filters every read on the company', async () => {
    const mock = createTableMockSupabase()
    await evidenceLines(mock.supabase as never, COMPANY, [
      [
        { kind: 'transaction', id: TX },
        { kind: 'journal_entry', id: ENTRY },
        { kind: 'invoice', id: INVOICE },
        { kind: 'supplier_invoice', id: SUPPLIER_INVOICE },
        { kind: 'document', id: DOCUMENT },
        { kind: 'fact', id: FACT },
        { kind: 'account', id: '1580' },
      ],
    ])
    for (const table of ['transactions', 'journal_entries', 'invoices', 'supplier_invoices', 'document_attachments', 'agent_memory', 'chart_of_accounts']) {
      expect(mock.findCalls(table, 'eq'), table).toEqual([['company_id', COMPANY]])
    }
    // No entry of the company was found, so no line of any entry is read.
    expect(mock.findCalls('journal_entry_lines', 'select')).toEqual([])
  })

  it('answers a reference that names no record of the company as a line that says so', async () => {
    const mock = createTableMockSupabase({
      transactions: { data: [{ id: TX, date: '2026-11-03', description: 'KORTKOP 1234', merchant_name: null, amount: -100, currency: null }] },
    })
    const [lines] = await evidenceLines(mock.supabase as never, COMPANY, [
      [
        { kind: 'transaction', id: TX },
        { kind: 'transaction', id: TX_GONE },
        { kind: 'transaction', id: 'not-a-uuid' },
        { kind: 'account', id: 'abc' },
      ],
    ])
    expect(lines[0]).toMatchObject({ found: true, label: 'KORTKOP 1234', currency: null })
    expect(lines.slice(1)).toEqual([
      { kind: 'transaction', id: TX_GONE, found: false, date: null, label: null, detail: null, amount: null, currency: null, href: null },
      { kind: 'transaction', id: 'not-a-uuid', found: false, date: null, label: null, detail: null, amount: null, currency: null, href: null },
      { kind: 'account', id: 'abc', found: false, date: null, label: null, detail: null, amount: null, currency: null, href: null },
    ])
    // A malformed id is never sent to the database.
    expect(mock.findCall('transactions', 'in')).toEqual(['id', [TX, TX_GONE]])
    expect(mock.findCalls('chart_of_accounts', 'select')).toEqual([])
  })

  it('reads each kind once for several questions', async () => {
    const mock = createTableMockSupabase({
      transactions: { data: [{ id: TX, date: '2026-11-03', description: 'Rad', merchant_name: null, amount: -1, currency: 'SEK' }] },
    })
    const lines = await evidenceLines(mock.supabase as never, COMPANY, [[{ kind: 'transaction', id: TX }], [], [{ kind: 'transaction', id: TX }]])
    expect(lines.map((question) => question.length)).toEqual([1, 0, 1])
    expect(mock.findCalls('transactions', 'select')).toHaveLength(1)
    expect(mock.findCall('transactions', 'in')).toEqual(['id', [TX]])
  })

  it('throws when a read fails', async () => {
    const mock = createTableMockSupabase({ transactions: { data: null, error: { message: 'boom', code: 'XX000' } } })
    await expect(evidenceLines(mock.supabase as never, COMPANY, [[{ kind: 'transaction', id: TX }]])).rejects.toThrow()
  })
})
