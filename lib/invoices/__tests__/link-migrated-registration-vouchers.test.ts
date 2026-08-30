import { describe, it, expect, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { roundOre } from '@/lib/money'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  linkMigratedRegistrationVouchers,
  type MigratedInvoiceLinkInput,
} from '../link-migrated-registration-vouchers'

/**
 * The linker joins a migrated invoice to the SIE-imported verifikat that
 * booked it in the source system (#1463). The tests pin the guardrails: a
 * link is written only for exactly one posted, unclaimed, amount-corroborated
 * verifikat, and every other case stays NULL with a reason. Journal tables
 * are never written.
 *
 * Read order (one queued result per `.from()`): source-ref vouchers, fiscal
 * periods, entry status, entry lines, supplier_invoices referencing the
 * entries, invoices referencing the entries, then one update per link.
 */

const COMPANY = 'company-1'
const PERIOD_2025 = 'period-2025'

const periods = [
  { id: 'period-2024', period_start: '2024-01-01', period_end: '2024-12-31', is_closed: false, locked_at: null },
  { id: PERIOD_2025, period_start: '2025-01-01', period_end: '2025-12-31', is_closed: false, locked_at: null },
]

function voucher(over: { id: string; series?: string | null; number?: number; period?: string; date?: string }) {
  return {
    id: over.id,
    fiscal_period_id: over.period ?? PERIOD_2025,
    entry_date: over.date ?? '2025-03-14',
    source_voucher_series: over.series === undefined ? 'A' : over.series,
    source_voucher_number: over.number ?? 329,
  }
}

function line(entry: string, account: string, debit: number, credit: number, id = `${entry}-${account}-${debit}-${credit}`) {
  return { id, journal_entry_id: entry, account_number: account, debit_amount: debit, credit_amount: credit }
}

/** A standard supplier registration voucher: Dr 5010 800, Dr 2641 200, Cr 2440 1000. */
function supplierLines(entry: string, total = 1000) {
  const net = roundOre(total * 0.8)
  const vat = roundOre(total - net)
  return [line(entry, '5010', net, 0), line(entry, '2641', vat, 0), line(entry, '2440', 0, total)]
}

/** A standard customer registration voucher: Dr 1510 1000, Cr 3001 800, Cr 2611 200. */
function customerLines(entry: string, total = 1000) {
  const net = roundOre(total * 0.8)
  const vat = roundOre(total - net)
  return [line(entry, '1510', total, 0), line(entry, '3001', 0, net), line(entry, '2611', 0, vat)]
}

function input(over: Partial<MigratedInvoiceLinkInput> & { invoiceId: string }): MigratedInvoiceLinkInput {
  return {
    kind: 'supplier',
    sourceVoucher: { series: 'A', number: 329 },
    invoiceDate: '2025-03-14',
    totalSek: 1000,
    invoiceNumber: `F-${over.invoiceId}`,
    ...over,
  }
}

interface Queue {
  vouchers?: unknown[]
  entries?: unknown[]
  lines?: unknown[]
  supplierRefs?: unknown[]
  customerRefs?: unknown[]
  updates?: { data?: unknown; error?: unknown }[]
}

let mock: ReturnType<typeof createQueuedMockSupabase>

function queue(q: Queue) {
  mock.enqueue({ data: q.vouchers ?? [] })
  mock.enqueue({ data: periods })
  if (q.entries !== undefined) mock.enqueue({ data: q.entries })
  if (q.lines !== undefined) mock.enqueue({ data: q.lines })
  if (q.supplierRefs !== undefined) mock.enqueue({ data: q.supplierRefs })
  if (q.customerRefs !== undefined) mock.enqueue({ data: q.customerRefs })
  for (const u of q.updates ?? []) mock.enqueue(u)
}

function run(invoices: MigratedInvoiceLinkInput[], dryRun = false) {
  return linkMigratedRegistrationVouchers({
    supabase: mock.supabase as unknown as SupabaseClient,
    companyId: COMPANY,
    invoices,
    dryRun,
  })
}

function updateCalls(table: 'supplier_invoices' | 'invoices') {
  return mock.calls.filter((c) => c.table === table && c.method === 'update')
}

/**
 * The filter calls chained onto the FIRST `update` on `table`, up to the next
 * `from`. Asserting on these (not on every `.eq` the module ever made against
 * the table) is what pins the tenancy and NULL guards to the write itself:
 * the referencing-invoice read earlier also filters on company_id.
 */
function updateChain(table: 'supplier_invoices' | 'invoices') {
  const start = mock.calls.findIndex((c) => c.table === table && c.method === 'update')
  if (start < 0) return []
  const chain: [string, unknown[]][] = []
  for (let i = start + 1; i < mock.calls.length; i++) {
    const c = mock.calls[i]
    if (c.table !== table) break
    chain.push([c.method, c.args])
  }
  return chain
}

beforeEach(() => {
  mock = createQueuedMockSupabase()
})

describe('linkMigratedRegistrationVouchers', () => {
  it('returns zeros and reads nothing for an empty input', async () => {
    const result = await run([])
    expect(result).toEqual({
      scanned: 0, linked: 0, noRef: 0, refNotFetched: 0, unresolved: 0, ambiguous: 0, amountMismatch: 0, alreadyLinked: 0, reports: [],
    })
    expect(mock.calls).toHaveLength(0)
  })

  it('links a supplier invoice to the posted verifikat that credits 2440 with its SEK total', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1'),
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [{ id: 'si-1' }] }],
    })

    const result = await run([input({ invoiceId: 'si-1' })])

    expect(result.linked).toBe(1)
    expect(result.reports[0]).toMatchObject({ invoiceId: 'si-1', outcome: 'linked', journalEntryId: 'je-1' })

    const [update] = updateCalls('supplier_invoices')
    expect(update.args[0]).toEqual({ registration_journal_entry_id: 'je-1' })
    // The write itself is scoped to the row, the company, and NULL only.
    expect(updateChain('supplier_invoices')).toEqual(expect.arrayContaining([
      ['eq', ['id', 'si-1']],
      ['eq', ['company_id', COMPANY]],
      ['is', ['registration_journal_entry_id', null]],
      ['select', ['id']],
    ]))
    expect(updateCalls('invoices')).toHaveLength(0)
  })

  it('links a customer invoice to the posted verifikat that debits 1510 with its SEK total', async () => {
    queue({
      vouchers: [voucher({ id: 'je-2', number: 12 })],
      entries: [{ id: 'je-2', status: 'posted' }],
      lines: customerLines('je-2', 2500),
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [{ id: 'inv-1' }] }],
    })

    const result = await run([
      input({ invoiceId: 'inv-1', kind: 'customer', sourceVoucher: { series: 'A', number: 12 }, totalSek: 2500 }),
    ])

    expect(result.linked).toBe(1)
    const [update] = updateCalls('invoices')
    expect(update.args[0]).toEqual({ journal_entry_id: 'je-2' })
    expect(updateChain('invoices')).toEqual(expect.arrayContaining([
      ['eq', ['id', 'inv-1']],
      ['eq', ['company_id', COMPANY]],
      ['is', ['journal_entry_id', null]],
      ['select', ['id']],
    ]))
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('resolves a series-less ref when exactly one verifikat carries the number in that year', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' }), voucher({ id: 'je-old', period: 'period-2024', date: '2024-03-14' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1'),
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [{ id: 'si-1' }] }],
    })

    const result = await run([input({ invoiceId: 'si-1', sourceVoucher: { series: null, number: 329 } })])

    expect(result.linked).toBe(1)
    expect(result.reports[0].journalEntryId).toBe('je-1')
  })

  it('reports noRef and writes nothing when the provider named no voucher', async () => {
    queue({ vouchers: [voucher({ id: 'je-1' })] })

    const result = await run([input({ invoiceId: 'si-1', sourceVoucher: null })])

    expect(result.noRef).toBe(1)
    expect(result.linked).toBe(0)
    expect(result.reports[0]).toMatchObject({ outcome: 'noRef' })
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
    // Only the two index reads happened.
    expect(mock.supabase.from).toHaveBeenCalledTimes(2)
  })

  it('reports refNotFetched (not noRef) when the provider detail payload was never fetched', async () => {
    queue({ vouchers: [voucher({ id: 'je-1' })] })

    const result = await run([input({ invoiceId: 'si-1', sourceVoucher: undefined, refNotFetched: true })])

    expect(result.refNotFetched).toBe(1)
    expect(result.noRef).toBe(0)
    expect(result.reports[0]).toMatchObject({ outcome: 'refNotFetched' })
    expect(result.reports[0].reason).toContain('not fetched')
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('does not link a December invoice to the previous year\'s same-numbered voucher (date corridor)', async () => {
    // Fortnox restarts numbering per year. An invoice dated 2024-12-28 that the
    // source booked in January 2025 carries FY2025's "B3"; resolving in the
    // invoice-date year finds FY2024's B3, an unrelated January-2024 voucher
    // from a recurring supplier with the identical amount. It must stay NULL.
    queue({
      vouchers: [voucher({ id: 'je-wrong-year', series: 'B', number: 3, period: 'period-2024', date: '2024-01-10' })],
    })

    const result = await run([
      input({ invoiceId: 'si-1', sourceVoucher: { series: 'B', number: 3 }, invoiceDate: '2024-12-28', totalSek: 1000 }),
    ])

    expect(result.linked).toBe(0)
    expect(result.unresolved).toBe(1)
    expect(result.reports[0].reason).toMatch(/dated 2024-01-10.*before the invoice date 2024-12-28/)
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
    // Never reached the corroboration reads.
    expect(mock.supabase.from).toHaveBeenCalledTimes(2)
  })

  it('applies the date corridor to series-less refs too', async () => {
    queue({
      vouchers: [voucher({ id: 'je-far', series: 'A', number: 329, date: '2025-11-30' })],
    })

    const result = await run([
      input({ invoiceId: 'si-1', sourceVoucher: { series: null, number: 329 }, invoiceDate: '2025-03-14' }),
    ])

    expect(result.unresolved).toBe(1)
    expect(result.reports[0].reason).toContain('after the invoice date')
  })

  it('accepts a verifikat booked a few weeks after, or a few days before, the invoice date', async () => {
    queue({
      vouchers: [
        voucher({ id: 'je-late', series: 'A', number: 329, date: '2025-04-30' }),
        voucher({ id: 'je-early', series: 'A', number: 330, date: '2025-03-04' }),
      ],
      entries: [{ id: 'je-late', status: 'posted' }, { id: 'je-early', status: 'posted' }],
      lines: [...supplierLines('je-late'), ...supplierLines('je-early')],
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [{ id: 'si-1' }] }, { data: [{ id: 'si-2' }] }],
    })

    const result = await run([
      input({ invoiceId: 'si-1', invoiceDate: '2025-03-14' }),
      input({ invoiceId: 'si-2', sourceVoucher: { series: 'A', number: 330 }, invoiceDate: '2025-03-14' }),
    ])

    expect(result.linked).toBe(2)
  })

  it('reports unresolved when no verifikat carries the ref in the invoice year', async () => {
    queue({ vouchers: [voucher({ id: 'je-old', period: 'period-2024', date: '2024-03-14' })] })

    const result = await run([input({ invoiceId: 'si-1' })])

    expect(result.unresolved).toBe(1)
    expect(result.reports[0]).toMatchObject({ outcome: 'unresolved' })
    expect(result.reports[0].reason).toContain('A329')
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('reports unresolved when no fiscal period covers the invoice date', async () => {
    queue({ vouchers: [voucher({ id: 'je-1' })] })

    const result = await run([input({ invoiceId: 'si-1', invoiceDate: '2019-05-05' })])

    expect(result.unresolved).toBe(1)
    expect(result.reports[0].reason).toContain('no fiscal period')
  })

  it('reports ambiguous when two verifikat in the year carry the same source ref', async () => {
    queue({ vouchers: [voucher({ id: 'je-1' }), voucher({ id: 'je-1b' })] })

    const result = await run([input({ invoiceId: 'si-1' })])

    expect(result.ambiguous).toBe(1)
    expect(result.reports[0]).toMatchObject({ outcome: 'ambiguous' })
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('reports ambiguous for a series-less ref that hits several series', async () => {
    queue({ vouchers: [voucher({ id: 'je-1', series: 'A' }), voucher({ id: 'je-1b', series: 'B' })] })

    const result = await run([input({ invoiceId: 'si-1', sourceVoucher: { series: null, number: 329 } })])

    expect(result.ambiguous).toBe(1)
    expect(result.reports[0].reason).toContain('2 series')
  })

  it('reports ambiguous for both invoices when they resolve to the same verifikat', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1'),
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1' }), input({ invoiceId: 'si-2' })])

    expect(result.ambiguous).toBe(2)
    expect(result.linked).toBe(0)
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('reports amountMismatch when the 2440 net credit differs from the invoice total', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1', 999),
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1', totalSek: 1000 })])

    expect(result.amountMismatch).toBe(1)
    expect(result.reports[0].reason).toContain('999')
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('explains a foreign-currency mismatch as a rate difference, and still does not link', async () => {
    // total_sek comes from our Riksbanken index; the source booked 2440 at its
    // own rate. The amounts differ, so the bucket is amountMismatch, but the
    // reason must say why instead of implying a bookkeeping discrepancy.
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1', 11240),
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1', totalSek: 11200, currencyCode: 'EUR' })])

    expect(result.amountMismatch).toBe(1)
    expect(result.linked).toBe(0)
    expect(result.reports[0].reason).toContain('EUR')
    expect(result.reports[0].reason).toContain('rate')
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('reports unresolved (never links) on a kontantmetod-style voucher with no 244x line at all', async () => {
    // Cash-method companies book the expense on payment: Dr 5010 / Cr 1930.
    // The provider may still name that voucher; it is NOT a registration
    // voucher, so it is neither linked nor counted as an amount mismatch.
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: [line('je-1', '5010', 1000, 0), line('je-1', '1930', 0, 1000)],
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1' })])

    expect(result.unresolved).toBe(1)
    expect(result.amountMismatch).toBe(0)
    expect(result.linked).toBe(0)
    expect(result.reports[0].reason).toContain('no 244x line')
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('reports unresolved for a customer invoice whose named voucher has no 151x line', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: [line('je-1', '1930', 1000, 0), line('je-1', '3001', 0, 1000)],
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'inv-1', kind: 'customer' })])

    expect(result.unresolved).toBe(1)
    expect(result.reports[0].reason).toContain('no 151x line')
    expect(updateCalls('invoices')).toHaveLength(0)
  })

  it('reports amountMismatch when the invoice has no SEK total', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1'),
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1', totalSek: null })])

    expect(result.amountMismatch).toBe(1)
    expect(result.reports[0].reason).toContain('no SEK total')
  })

  it('tolerates half an öre and sums several 244x lines (2440 + 2441)', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: [
        line('je-1', '5010', 1000.004, 0),
        line('je-1', '2440', 0, 600),
        line('je-1', '2441', 0, 400),
      ],
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [{ id: 'si-1' }] }],
    })

    const result = await run([input({ invoiceId: 'si-1', totalSek: 1000.004 })])

    expect(result.linked).toBe(1)
  })

  it('reports alreadyLinked when another invoice already references the verifikat', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1'),
      supplierRefs: [{ id: 'si-other', registration_journal_entry_id: 'je-1' }],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1' })])

    expect(result.alreadyLinked).toBe(1)
    expect(result.reports[0].reason).toContain('another invoice')
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('reports alreadyLinked (idempotent re-run) when the invoice itself already links the verifikat', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1'),
      supplierRefs: [{ id: 'si-1', registration_journal_entry_id: 'je-1' }],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1' })])

    expect(result.alreadyLinked).toBe(1)
    expect(result.reports[0].reason).toContain('already links')
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('reports alreadyLinked when the NULL-guarded update matches no row', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1'),
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [] }],
    })

    const result = await run([input({ invoiceId: 'si-1' })])

    expect(result.alreadyLinked).toBe(1)
    expect(result.linked).toBe(0)
  })

  it('rejects a verifikat the company-scoped status read does not return (cross-company)', async () => {
    queue({
      vouchers: [voucher({ id: 'je-foreign' })],
      entries: [],
      lines: [],
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1' })])

    expect(result.unresolved).toBe(1)
    expect(result.reports[0].reason).toContain('not found in this company')
    expect(mock.findCalls('journal_entries', 'eq')).toEqual(
      expect.arrayContaining([['company_id', COMPANY]]),
    )
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('rejects a verifikat that is not posted', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'reversed' }],
      lines: supplierLines('je-1'),
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1' })])

    expect(result.unresolved).toBe(1)
    expect(result.reports[0].reason).toContain('reversed')
  })

  it('dry run decides without writing', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1'),
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1' })], true)

    expect(result.linked).toBe(1)
    expect(result.reports[0].reason).toContain('dry run')
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('throws on a database error instead of reporting a phantom outcome', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1'),
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: null, error: { message: 'boom' } }],
    })

    await expect(run([input({ invoiceId: 'si-1' })])).rejects.toThrow(/boom/)
  })

  it('never writes to journal tables', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1'),
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [{ id: 'si-1' }] }],
    })

    await run([input({ invoiceId: 'si-1' })])

    const journalWrites = mock.calls.filter(
      (c) => (c.table === 'journal_entries' || c.table === 'journal_entry_lines')
        && ['update', 'insert', 'delete', 'upsert'].includes(c.method),
    )
    expect(journalWrites).toHaveLength(0)
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })
})
