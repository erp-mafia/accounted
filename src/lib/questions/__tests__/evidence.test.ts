import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const accountBalanceThrough = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bookkeeping/account-balance', () => ({ accountBalanceThrough }))

import { resolveEvidence } from '../evidence'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const TX = '10000000-0000-4000-8000-000000000001'
const ENTRY = '20000000-0000-4000-8000-000000000001'
const DOC = '30000000-0000-4000-8000-000000000001'
const INVOICE = '40000000-0000-4000-8000-000000000001'
const SUPPLIER_INVOICE = '50000000-0000-4000-8000-000000000001'
const FACT = '60000000-0000-4000-8000-000000000001'
const GONE = '90000000-0000-4000-8000-000000000009'

describe('resolveEvidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    accountBalanceThrough.mockResolvedValue(-316000.25)
  })

  it('finds every kind in the company and collects the amounts that stand on them', async () => {
    const mock = createTableMockSupabase({
      transactions: { data: [{ id: TX, amount: -4990, amount_sek: '-4990.00', instructed_amount: null }] },
      journal_entries: { data: [{ id: ENTRY }] },
      journal_entry_lines: {
        data: [
          { id: 'l1', journal_entry_id: ENTRY, debit_amount: 500, credit_amount: 0, amount_in_currency: null },
          { id: 'l2', journal_entry_id: ENTRY, debit_amount: 125, credit_amount: 0, amount_in_currency: null },
          { id: 'l3', journal_entry_id: ENTRY, debit_amount: 0, credit_amount: 625, amount_in_currency: 57.5 },
        ],
      },
      document_attachments: {
        data: [{ id: DOC, extracted_data: { totals: { total: 10242.28, vatAmount: null }, prominentAmounts: [{ amount: 3000000, label: null }] } }],
      },
      invoices: {
        data: [{ id: INVOICE, total: 1250, total_sek: 1250, subtotal: 1000, subtotal_sek: 1000, vat_amount: 250, vat_amount_sek: 250, remaining_amount: 1250, paid_amount: 0 }],
      },
      supplier_invoices: {
        data: [{ id: SUPPLIER_INVOICE, total: 99, total_sek: 1090.5, subtotal: 99, subtotal_sek: 1090.5, vat_amount: 0, vat_amount_sek: 0, remaining_amount: 0, paid_amount: 99 }],
      },
      agent_memory: { data: [{ id: FACT, content: 'Hyran är 18 500 kr i månaden.' }] },
      chart_of_accounts: { data: [{ account_number: '1580' }] },
    })

    const resolved = await resolveEvidence(mock.supabase as never, COMPANY, [
      { kind: 'transaction', id: TX },
      { kind: 'journal_entry', id: ENTRY },
      { kind: 'document', id: DOC },
      { kind: 'invoice', id: INVOICE },
      { kind: 'supplier_invoice', id: SUPPLIER_INVOICE },
      { kind: 'fact', id: FACT },
      { kind: 'account', id: '1580' },
    ])

    expect(resolved.missing).toEqual([])
    // The transaction, the entry's lines and its total, the document's totals,
    // the invoices, the fact's own amount and the account balance.
    for (const amount of [-4990, 500, 125, 625, 57.5, 10242.28, 3000000, 1250, 1000, 250, 1090.5, 99, 18500, -316000.25]) {
      expect(resolved.amounts, String(amount)).toContain(amount)
    }
    expect(resolved.amounts.filter((a) => a === 625)).toHaveLength(2)
    expect(accountBalanceThrough).toHaveBeenCalledWith(mock.supabase, COMPANY, '1580', expect.any(String))

    // Every read is scoped to the company (the lines are read by their entry).
    for (const table of ['transactions', 'journal_entries', 'document_attachments', 'invoices', 'supplier_invoices', 'agent_memory', 'chart_of_accounts']) {
      expect(mock.findCalls(table, 'eq'), table).toContainEqual(['company_id', COMPANY])
    }
    expect(mock.findCall('journal_entry_lines', 'in')).toEqual(['journal_entry_id', [ENTRY]])
  })

  it('names a reference that is not a record of the company', async () => {
    const mock = createTableMockSupabase({
      transactions: { data: [{ id: TX, amount: -100, amount_sek: -100, instructed_amount: null }] },
      journal_entries: { data: [] },
      chart_of_accounts: { data: [] },
    })
    const resolved = await resolveEvidence(mock.supabase as never, COMPANY, [
      { kind: 'transaction', id: TX },
      { kind: 'transaction', id: GONE },
      { kind: 'journal_entry', id: GONE },
      { kind: 'account', id: '9999' },
    ])
    expect(resolved.missing).toEqual([
      { kind: 'transaction', id: GONE },
      { kind: 'journal_entry', id: GONE },
      { kind: 'account', id: '9999' },
    ])
    expect(resolved.amounts).toEqual([-100, -100])
    // No lines are read when no entry was found, and no balance without an account.
    expect(mock.tables()).not.toContain('journal_entry_lines')
    expect(accountBalanceThrough).not.toHaveBeenCalled()
  })

  it('never queries with a malformed id: it is missing', async () => {
    const mock = createTableMockSupabase()
    const refs = [
      { kind: 'transaction' as const, id: 'not-a-uuid' },
      { kind: 'fact' as const, id: "x'); drop" },
      { kind: 'account' as const, id: '19300' },
      { kind: 'account' as const, id: '19,30' },
    ]
    const resolved = await resolveEvidence(mock.supabase as never, COMPANY, refs)
    expect(resolved.missing).toEqual(refs)
    expect(mock.tables()).toEqual([])
  })

  it('leaves out a balance that could not be read', async () => {
    accountBalanceThrough.mockResolvedValue(null)
    const mock = createTableMockSupabase({ chart_of_accounts: { data: [{ account_number: '1930' }] } })
    const resolved = await resolveEvidence(mock.supabase as never, COMPANY, [{ kind: 'account', id: '1930' }])
    expect(resolved).toEqual({ missing: [], amounts: [] })
  })

  it('throws when a read fails', async () => {
    const mock = createTableMockSupabase({ invoices: { error: { code: '57014', message: 'canceling statement due to statement timeout' } } })
    await expect(resolveEvidence(mock.supabase as never, COMPANY, [{ kind: 'invoice', id: INVOICE }])).rejects.toMatchObject({
      code: '57014',
    })
  })
})
