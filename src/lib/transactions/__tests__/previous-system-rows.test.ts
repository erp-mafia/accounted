/**
 * Bank rows the previous system already booked (crm#1954): the cut-off, the
 * selection and the write.
 *
 * The rows are read through a mock that applies the chain's filters, with
 * open_bank_rows seeded as the view holds them (not ignored, not private, no
 * live verifikat), so a test says what a real query would return.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createRowsMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { findPreviousSystemRows, markPreviousSystemRows } from '@/lib/transactions/previous-system-rows'

const COMPANY = 'company-1'
const CUTOFF = '2026-09-30'

type Row = Record<string, unknown>

/** A bank row as public.transactions holds it; `booked` stands for a live anchor of any kind. */
function tx(id: string, date: string, extra: Row = {}): Row {
  return {
    id,
    company_id: COMPANY,
    date,
    is_business: null,
    is_ignored: false,
    journal_entry_id: null,
    invoice_id: null,
    supplier_invoice_id: null,
    document_id: null,
    receipt_id: null,
    potential_journal_entry_id: null,
    booked: false,
    ...extra,
  }
}

/** What public.open_bank_rows holds of the rows, as a snapshot taken now. */
function openOf(rows: Row[]): Row[] {
  return rows.filter((r) => !r.is_ignored && r.is_business !== false && !r.booked).map((r) => ({ ...r }))
}

/** The update on transactions: applies the chain's filters to the rows, writes them and answers their ids. */
function writeTo(rows: Row[]): TableMockResolver {
  return (chain) => {
    let out = rows
    for (const { method, args } of chain) {
      const [column, value] = args as [string, unknown]
      if (method === 'eq') out = out.filter((r) => r[column] === value)
      else if (method === 'in') out = out.filter((r) => (value as unknown[]).includes(r[column]))
      else if (method === 'is') out = out.filter((r) => (r[column] ?? null) === value)
      else if (method === 'lte') out = out.filter((r) => String(r[column]) <= String(value))
    }
    const update = chain.find((c) => c.method === 'update')
    if (!update) return { data: out, error: null }
    for (const r of out) Object.assign(r, update.args[0] as Row)
    return { data: out.map((r) => ({ id: r.id })), error: null }
  }
}

interface Seed {
  rows?: Row[]
  imported?: boolean
  entries?: Row[]
  links?: Partial<Record<'transaction_voucher_links' | 'invoice_payments' | 'supplier_invoice_payments', Row[]>>
}

function seed({ rows = [], imported = true, entries, links = {} }: Seed) {
  const mock = createRowsMockSupabase({
    sie_imports: imported ? [{ id: 'import-1', company_id: COMPANY, status: 'completed' }] : [],
    journal_entries: entries ?? [
      { id: 'e-1', company_id: COMPANY, entry_date: '2026-05-01', status: 'posted', source_type: 'import', description: 'Hyra' },
      { id: 'e-2', company_id: COMPANY, entry_date: CUTOFF, status: 'posted', source_type: 'import', description: 'Bankavgift' },
    ],
    open_bank_rows: openOf(rows),
    transaction_voucher_links: links.transaction_voucher_links ?? [],
    invoice_payments: links.invoice_payments ?? [],
    supplier_invoice_payments: links.supplier_invoice_payments ?? [],
  })
  mock.setTable('transactions', writeTo(rows))
  return { ...mock, client: mock.supabase as unknown as SupabaseClient }
}

describe('findPreviousSystemRows', () => {
  it('has no cut-off and reads no bank rows for a company without a completed SIE import', async () => {
    const { client, tables } = seed({ imported: false, rows: [tx('a1', '2026-06-01')] })

    await expect(findPreviousSystemRows(client, COMPANY)).resolves.toEqual({
      cutoff: null,
      ids: [],
      first_date: null,
      last_date: null,
    })
    expect(tables()).not.toContain('open_bank_rows')
  })

  it('takes the cut-off from the newest posted imported verifikat, not from later manual or draft ones', async () => {
    const { client } = seed({
      rows: [tx('a1', '2026-09-30'), tx('a2', '2026-10-10')],
      entries: [
        { id: 'e-1', company_id: COMPANY, entry_date: CUTOFF, status: 'posted', source_type: 'import', description: 'Leverantörsbetalning' },
        { id: 'e-2', company_id: COMPANY, entry_date: '2026-10-20', status: 'posted', source_type: 'manual', description: 'Hyra oktober' },
        { id: 'e-3', company_id: COMPANY, entry_date: '2026-10-25', status: 'draft', source_type: 'import', description: 'Utkast' },
      ],
    })

    const found = await findPreviousSystemRows(client, COMPANY)
    expect(found.cutoff).toBe(CUTOFF)
    expect(found.ids).toEqual(['a1'])
  })

  it('selects the open rows on or before the cut-off that nothing links, and nothing else', async () => {
    const { client } = seed({
      rows: [
        tx('a1', '2026-05-04'),
        tx('a2', '2026-07-31'),
        tx('a3', CUTOFF),
        tx('b-after', '2026-10-01'),
        tx('b-booked', '2026-06-01', { booked: true }),
        tx('b-ignored', '2026-06-02', { is_ignored: true }),
        tx('b-private', '2026-06-03', { is_business: false }),
        tx('b-categorized', '2026-06-04', { is_business: true }),
        tx('b-stale-pointer', '2026-06-05', { journal_entry_id: 'reversed-1' }),
        tx('b-invoice', '2026-06-06', { invoice_id: 'inv-1' }),
        tx('b-supplier-invoice', '2026-06-07', { supplier_invoice_id: 'si-1' }),
        tx('b-underlag', '2026-06-08', { document_id: 'doc-1' }),
        tx('b-receipt', '2026-06-09', { receipt_id: 'rc-1' }),
        tx('b-proposed-match', '2026-06-10', { potential_journal_entry_id: 'e-1' }),
        tx('b-voucher-link', '2026-06-11'),
        tx('b-payment', '2026-06-12'),
        tx('b-other-company', '2026-06-13', { company_id: 'company-2' }),
      ],
      links: {
        transaction_voucher_links: [{ company_id: COMPANY, transaction_id: 'b-voucher-link', role: 'other' }],
        supplier_invoice_payments: [{ company_id: COMPANY, transaction_id: 'b-payment', journal_entry_id: null }],
      },
    })

    await expect(findPreviousSystemRows(client, COMPANY)).resolves.toEqual({
      cutoff: CUTOFF,
      ids: ['a1', 'a2', 'a3'],
      first_date: '2026-05-04',
      last_date: CUTOFF,
    })
  })

  it('answers an empty selection when every row before the cut-off is booked', async () => {
    const { client } = seed({ rows: [tx('b-booked', '2026-06-01', { booked: true }), tx('b-after', '2026-11-02')] })

    await expect(findPreviousSystemRows(client, COMPANY)).resolves.toEqual({
      cutoff: CUTOFF,
      ids: [],
      first_date: null,
      last_date: null,
    })
  })

  it('fails when a link table cannot be read: the selection would be a guess', async () => {
    const { client, setTable } = seed({ rows: [tx('a1', '2026-06-01')] })
    setTable('invoice_payments', { data: null, error: { message: 'boom', code: '57014' } })

    await expect(findPreviousSystemRows(client, COMPANY)).rejects.toThrow('boom')
  })
})

describe('markPreviousSystemRows', () => {
  it('sets the ignore flag on exactly the selected rows and leaves every other row as it was', async () => {
    const rows = [
      tx('a1', '2026-05-04'),
      tx('a2', CUTOFF),
      tx('b-after', '2026-10-01'),
      tx('b-booked', '2026-06-01', { booked: true }),
      tx('b-invoice', '2026-06-06', { invoice_id: 'inv-1' }),
    ]
    const { client, findCalls } = seed({ rows })

    await expect(markPreviousSystemRows(client, COMPANY, CUTOFF)).resolves.toEqual({
      ok: true,
      cutoff: CUTOFF,
      transaction_ids: ['a1', 'a2'],
    })
    const flags = Object.fromEntries(rows.map((r) => [r.id, r.is_ignored]))
    expect(flags).toEqual({ a1: true, a2: true, 'b-after': false, 'b-booked': false, 'b-invoice': false })
    // The write is the ignore flag alone: no pointer, category or verifikat.
    expect(findCalls('transactions', 'update').map(([payload]) => payload)).toEqual([{ is_ignored: true }])
  })

  it('skips a row categorized between the read and the write', async () => {
    const rows = [tx('a1', '2026-05-04'), tx('a2', '2026-06-01')]
    const { client } = seed({ rows })
    // The view was read before the person booked a2.
    rows[1].is_business = true

    const outcome = await markPreviousSystemRows(client, COMPANY, CUTOFF)
    expect(outcome).toEqual({ ok: true, cutoff: CUTOFF, transaction_ids: ['a1'] })
    expect(rows[1].is_ignored).toBe(false)
  })

  it('writes nothing when the cut-off is not the one the person saw', async () => {
    const rows = [tx('a1', '2026-05-04')]
    const { client, findCalls } = seed({ rows })

    await expect(markPreviousSystemRows(client, COMPANY, '2026-08-31')).resolves.toEqual({
      ok: false,
      reason: 'cutoff_changed',
      cutoff: CUTOFF,
    })
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(rows[0].is_ignored).toBe(false)
  })

  it('writes nothing for a company whose SIE import is gone', async () => {
    const rows = [tx('a1', '2026-05-04')]
    const { client, findCalls } = seed({ rows, imported: false })

    await expect(markPreviousSystemRows(client, COMPANY, CUTOFF)).resolves.toEqual({
      ok: false,
      reason: 'no_import',
      cutoff: null,
    })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('writes in chunks of 100 ids', async () => {
    const rows = Array.from({ length: 205 }, (_, i) => tx(`a${String(i).padStart(3, '0')}`, '2026-06-01'))
    const { client, findCalls } = seed({ rows })

    const outcome = await markPreviousSystemRows(client, COMPANY, CUTOFF)
    expect(outcome.ok && outcome.transaction_ids.length).toBe(205)
    expect(findCalls('transactions', 'in').map(([, ids]) => (ids as string[]).length)).toEqual([100, 100, 5])
  })
})
