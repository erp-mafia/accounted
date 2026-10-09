import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { roundOre } from '@/lib/money'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  linkMigratedRegistrationVouchers,
  type MigratedInvoiceLinkInput,
} from '../link-migrated-registration-vouchers'
import { supplierPayableEffectSek } from '@/lib/supplier-invoices/credit-note'

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

vi.mock('../attach-settlement-voucher', () => ({ attachSupplierInvoiceSettlementVoucher: vi.fn() }))
import { attachSupplierInvoiceSettlementVoucher } from '../attach-settlement-voucher'

const COMPANY = 'company-1'
const PERIOD_2025 = 'period-2025'

const periods = [
  { id: 'period-2024', period_start: '2024-01-01', period_end: '2024-12-31', is_closed: false, locked_at: null },
  { id: PERIOD_2025, period_start: '2025-01-01', period_end: '2025-12-31', is_closed: false, locked_at: null },
]

function voucher(over: { id: string; series?: string | null; number?: number; period?: string; date?: string;
  status?: 'posted' | 'reversed' }) {
  return {
    id: over.id,
    fiscal_period_id: over.period ?? PERIOD_2025,
    entry_date: over.date ?? '2025-03-14',
    source_voucher_series: over.series === undefined ? 'A' : over.series,
    source_voucher_number: over.number ?? 329,
    status: over.status ?? 'posted',
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
  /** The invoice rows a source-rate link reads: the customer read first, then the supplier read. */
  foreignRows?: unknown[][]
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
  for (const rows of q.foreignRows ?? []) mock.enqueue({ data: rows })
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

  it('links a supplier credit note on its payable effect, and never on the magnitude the row stores (#2838)', async () => {
    // A supplier kreditfaktura's verifikat DEBITS 2440: Dr 2440 1000, Cr 5010
    // 800, Cr 2641 200, a net credit of -1000. The row stores 1000 beside
    // is_credit_note, so the callers pass supplierPayableEffectSek.
    const creditLines = [line('je-1', '2440', 1000, 0), line('je-1', '5010', 0, 800), line('je-1', '2641', 0, 200)]
    const stored = 1000
    queue({ vouchers: [voucher({ id: 'je-1' })], entries: [{ id: 'je-1', status: 'posted' }], lines: creditLines,
      supplierRefs: [], customerRefs: [], updates: [{ data: [{ id: 'scn-1' }] }] })
    const linked = await run([input({ invoiceId: 'scn-1', totalSek: supplierPayableEffectSek(stored, true) })])
    expect(linked.reports[0]).toMatchObject({ outcome: 'linked', journalEntryId: 'je-1' })

    mock = createQueuedMockSupabase()
    queue({ vouchers: [voucher({ id: 'je-1' })], entries: [{ id: 'je-1', status: 'posted' }], lines: creditLines,
      supplierRefs: [], customerRefs: [] })
    const mismatched = await run([input({ invoiceId: 'scn-1', totalSek: stored })])
    expect(mismatched.reports[0]).toMatchObject({ outcome: 'amountMismatch' })
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
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

  it('reports ambiguous for a series-less ref when several dated series carry the total, or none does', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1', series: 'A' }), voucher({ id: 'je-1b', series: 'B' })],
      entries: [{ id: 'je-1', status: 'posted' }, { id: 'je-1b', status: 'posted' }],
      lines: [...supplierLines('je-1'), ...supplierLines('je-1b')],
      supplierRefs: [],
      customerRefs: [],
    })
    const both = await run([input({ invoiceId: 'si-1', sourceVoucher: { series: null, number: 329 } })])
    expect(both.ambiguous).toBe(1)
    expect(both.reports[0].reason).toContain('2 series dated with the invoice; 2 of them carry the invoice total')
    expect(updateCalls('supplier_invoices')).toHaveLength(0)

    mock = createQueuedMockSupabase()
    queue({
      vouchers: [voucher({ id: 'je-1', series: 'A' }), voucher({ id: 'je-1b', series: 'B' })],
      entries: [{ id: 'je-1', status: 'posted' }, { id: 'je-1b', status: 'posted' }],
      lines: [...supplierLines('je-1', 500), ...supplierLines('je-1b', 700)],
      supplierRefs: [],
      customerRefs: [],
    })
    const none = await run([input({ invoiceId: 'si-1', sourceVoucher: { series: null, number: 329 } })])
    expect(none.ambiguous).toBe(1)
    expect(none.reports[0].reason).toContain('0 of them carry the invoice total')
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  /**
   * A Visma customer's ledger keeps kundfakturor in series K and their
   * payments in series I, numbered independently, while Visma names only the
   * number: 2933 imported invoices sat in review with one date-and-amount
   * match each.
   */
  it('picks the series dated with the invoice when a series-less number is carried by several', async () => {
    queue({
      vouchers: [
        voucher({ id: 'je-k', series: 'K', number: 1884, date: '2025-06-01' }),
        voucher({ id: 'je-i', series: 'I', number: 1884, date: '2025-04-01' }),
      ],
      entries: [{ id: 'je-k', status: 'posted' }],
      lines: customerLines('je-k', 4156),
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [{ id: 'inv-1' }] }],
    })

    const result = await run([input({ invoiceId: 'inv-1', kind: 'customer', sourceVoucher: { series: null, number: 1884 },
      invoiceDate: '2025-06-01', totalSek: 4156 })])

    expect(result.linked).toBe(1)
    expect(result.reports[0].journalEntryId).toBe('je-k')
    expect(updateCalls('invoices')[0].args[0]).toEqual({ journal_entry_id: 'je-k' })
  })

  it('picks, among several series dated with the invoice, the one that books its total on 1510', async () => {
    queue({
      vouchers: [
        voucher({ id: 'je-k', series: 'K', number: 1884, date: '2025-06-01' }),
        voucher({ id: 'je-i', series: 'I', number: 1884, date: '2025-06-19' }),
      ],
      entries: [{ id: 'je-k', status: 'posted' }, { id: 'je-i', status: 'posted' }],
      // The payment voucher nets the receivable the other way: Dr 1930, Cr 1510.
      lines: [...customerLines('je-k', 4156), line('je-i', '1930', 4156, 0), line('je-i', '1510', 0, 4156)],
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [{ id: 'inv-1' }] }],
    })

    const result = await run([input({ invoiceId: 'inv-1', kind: 'customer', sourceVoucher: { series: null, number: 1884 },
      invoiceDate: '2025-06-01', totalSek: 4156 })])

    expect(result.linked).toBe(1)
    expect(result.reports[0].journalEntryId).toBe('je-k')
    expect(updateCalls('invoices')).toHaveLength(1)
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

  it('does not link a foreign-currency invoice at the source rate when its row cannot be read', async () => {
    // total_sek comes from our Riksbanken index; the source booked 2440 at its
    // own rate. Within the band the invoice takes the booked amount instead
    // (crm#1039), but the rate is derived from its row, and this row is gone:
    // the bucket stays amountMismatch, and the reason says why.
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1', 11240),
      supplierRefs: [],
      customerRefs: [],
      foreignRows: [[]],
    })

    const result = await run([input({ invoiceId: 'si-1', totalSek: 11200, currencyCode: 'EUR' })])

    expect(result.amountMismatch).toBe(1)
    expect(result.linked).toBe(0)
    expect(result.reports[0].reason).toContain('EUR')
    expect(result.reports[0].reason).toContain('rate')
    // The two amounts travel with the report, so the import review can show
    // the difference without parsing the reason text.
    expect(result.reports[0]).toMatchObject({ bookedSek: 11240, expectedSek: 11200 })
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
    expect(result.reports[0].bookedSek).toBeUndefined()
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

  it('reports a reversal even when the original voucher still has posted status', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted', reversed_by_id: 'storno-1' }],
      lines: supplierLines('je-1'),
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1' })])

    expect(result.reports[0]).toMatchObject({
      outcome: 'unresolved', reason: 'verifikat has been reversed (storno)',
    })
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
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

it('limits a durable batch to its source voucher numbers and preserves dry-run safety', async () => {
  mock = createQueuedMockSupabase()
  queue({ vouchers: [voucher({ id: 'v1' })], entries: [{ id: 'v1', status: 'posted' }],
    lines: supplierLines('v1'), supplierRefs: [], customerRefs: [] })
  const result = await linkMigratedRegistrationVouchers({ supabase: mock.supabase as unknown as SupabaseClient,
    companyId: COMPANY, invoices: [input({ invoiceId: 'i1' })], bounded: true, dryRun: true })
  expect(result.linked).toBe(1)
  expect(mock.calls.some(c => c.table === 'journal_entries' && c.method === 'in' && c.args[0] === 'source_voucher_number'
    && JSON.stringify(c.args[1]) === '[329]')).toBe(true)
  expect(mock.calls.filter(c => c.method === 'update' || c.method === 'insert')).toHaveLength(0)
})


describe('Bokio cash-purchase source references', () => {
  beforeEach(() => {
    mock = createQueuedMockSupabase()
    vi.mocked(attachSupplierInvoiceSettlementVoucher).mockReset()
    vi.mocked(attachSupplierInvoiceSettlementVoucher).mockResolvedValue({ ok: true } as never)
  })
  function cashQueue() {
    queue({ vouchers: [voucher({ id: 'cash' })], entries: [{ id: 'cash', status: 'posted' }],
      lines: [line('cash', '4000', 800, 0), line('cash', '2641', 200, 0), line('cash', '1930', 0, 1000)],
      supplierRefs: [], customerRefs: [] })
  }
  const cashInput = () => input({ invoiceId: 'paid', currencyCode: 'SEK',
    sourceVoucher: { series: 'A', number: 329, date: '2025-03-14' },
    settlement: { sourcePaid: true, userId: 'user' } })
  it('attaches settlement evidence without writing the registration FK', async () => {
    cashQueue()
    expect((await run([cashInput()])).reports[0]).toMatchObject({ outcome: 'linked', linkType: 'settlement' })
    expect(attachSupplierInvoiceSettlementVoucher).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: false, journalEntryId: 'cash' }))
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })
  it('uses the source entry date across a fiscal year boundary', async () => {
    cashQueue()
    expect((await run([{ ...cashInput(), invoiceDate: '2024-12-20' }], true)).linked).toBe(1)
    expect(attachSupplierInvoiceSettlementVoucher).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: true }))
  })
  it('reports an open source invoice and refuses a mismatched source date', async () => {
    cashQueue()
    expect((await run([{ ...cashInput(), settlement: { sourcePaid: false, userId: 'user' } }])).unresolved).toBe(1)
    expect(attachSupplierInvoiceSettlementVoucher).not.toHaveBeenCalled()
    mock = createQueuedMockSupabase(); cashQueue()
    expect((await run([{ ...cashInput(), sourceVoucher: { series: 'A', number: 329, date: '2025-03-15' } }])).linked).toBe(0)
    expect(attachSupplierInvoiceSettlementVoucher).not.toHaveBeenCalled()
  })
})

describe('foreign-currency invoices at the source rate (crm#1039)', () => {
  beforeEach(() => {
    mock = createQueuedMockSupabase()
  })

  // 1 000 EUR imported at our 11.20 (11 200.00 kr); the source booked 1510
  // at its own 11.2345 (11 234.50 kr), dated with the invoice.
  const eurCustomerInput = () => input({ invoiceId: 'inv-eur', kind: 'customer', sourceVoucher: { series: 'B', number: 501 },
    totalSek: 11200, currencyCode: 'EUR' })
  const eurCustomerRow = { id: 'inv-eur', currency: 'EUR', total: 1000, subtotal: 1000, vat_amount: 0, total_sek: 11200, exchange_rate: 11.2 }
  function eurCustomerQueue(updates?: { data?: unknown }[]) {
    queue({
      vouchers: [voucher({ id: 'je-eur', series: 'B', number: 501 })],
      entries: [{ id: 'je-eur', status: 'posted' }],
      lines: [line('je-eur', '1510', 11234.5, 0), line('je-eur', '3105', 0, 11234.5)],
      supplierRefs: [],
      customerRefs: [],
      foreignRows: [[eurCustomerRow]],
      updates,
    })
  }
  const eurSourceRate = {
    total: 1000, totalSek: 11234.5, subtotalSek: 11234.5, vatAmountSek: 0, exchangeRate: 11.2345,
    exchangeRateDate: '2025-03-14', previousTotalSek: 11200, previousExchangeRate: 11.2,
  }

  it('links the invoice and reports the SEK amount the verifikat books, writing nothing in a dry run', async () => {
    eurCustomerQueue()

    const result = await run([eurCustomerInput()], true)

    expect(result.linked).toBe(1)
    expect(result.amountMismatch).toBe(0)
    expect(result.reports[0]).toMatchObject({ outcome: 'linked', journalEntryId: 'je-eur', sourceRate: eurSourceRate })
    // The rate gives the 1510 debit back the way the reskontra and the
    // payment lines round it, so a payment of the 8 800 EUR clears 1510.
    expect(Math.round(1000 * result.reports[0].sourceRate!.exchangeRate * 100) / 100).toBe(11234.5)
    expect(mock.calls.filter((c) => c.method === 'update' || c.method === 'insert')).toHaveLength(0)
  })

  it('writes the link and the SEK amount in one update, from NULL and only for the total it was derived from', async () => {
    eurCustomerQueue([{ data: [{ id: 'inv-eur' }] }])

    const result = await run([eurCustomerInput()])

    expect(result.reports[0]).toMatchObject({ outcome: 'linked', reason: 'registration voucher linked at the source rate' })
    const [update] = updateCalls('invoices')
    expect(update.args[0]).toEqual({
      journal_entry_id: 'je-eur', exchange_rate: 11.2345, exchange_rate_date: '2025-03-14',
      total_sek: 11234.5, subtotal_sek: 11234.5, vat_amount_sek: 0,
    })
    expect(updateChain('invoices')).toEqual(expect.arrayContaining([
      ['eq', ['id', 'inv-eur']],
      ['eq', ['company_id', COMPANY]],
      ['is', ['journal_entry_id', null]],
      ['eq', ['total', 1000]],
      ['select', ['id']],
    ]))
  })

  it('takes a supplier credit note\'s magnitude from the 2440 debit', async () => {
    // 250 EUR, imported at 11.30 (2 825.00 kr); the verifikat debits 2440
    // with 2 811.25 kr, the source's 11.245.
    queue({
      vouchers: [voucher({ id: 'je-cn' })],
      entries: [{ id: 'je-cn', status: 'posted' }],
      lines: [line('je-cn', '2440', 2811.25, 0), line('je-cn', '4010', 0, 2811.25)],
      supplierRefs: [],
      customerRefs: [],
      foreignRows: [[{ id: 'scn-eur', currency: 'EUR', total: 250, subtotal: 250, vat_amount: 0, total_sek: 2825,
        exchange_rate: 11.3, is_credit_note: true }]],
    })

    const result = await run([input({ invoiceId: 'scn-eur', currencyCode: 'EUR', totalSek: supplierPayableEffectSek(2825, true) })], true)

    expect(result.reports[0]).toMatchObject({ outcome: 'linked', journalEntryId: 'je-cn',
      sourceRate: { total: 250, totalSek: 2811.25, subtotalSek: 2811.25, exchangeRate: 11.245 } })
  })

  it('keeps a verifikat more than 10% from the SEK total as amountMismatch, and reads no invoice row', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1', 12500),
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1', totalSek: 11200, currencyCode: 'EUR' })])

    expect(result.amountMismatch).toBe(1)
    expect(result.reports[0].reason).toContain('more than 10% apart')
    expect(result.reports[0].sourceRate).toBeUndefined()
    expect(mock.calls.filter((c) => c.table === 'supplier_invoices' && c.method === 'select')).toHaveLength(1)
    expect(updateCalls('supplier_invoices')).toHaveLength(0)
  })

  it('never re-rates a SEK invoice, whatever the difference', async () => {
    queue({
      vouchers: [voucher({ id: 'je-1' })],
      entries: [{ id: 'je-1', status: 'posted' }],
      lines: supplierLines('je-1', 1001),
      supplierRefs: [],
      customerRefs: [],
    })

    const result = await run([input({ invoiceId: 'si-1', totalSek: 1000, currencyCode: 'SEK' })])

    expect(result.amountMismatch).toBe(1)
    expect(result.reports[0].sourceRate).toBeUndefined()
    expect(mock.calls.filter((c) => c.table === 'supplier_invoices' && c.method === 'select')).toHaveLength(1)
  })

  it('falls back to the plain quotient when no four- or six-decimal rate gives the booked amount back', async () => {
    queue({
      vouchers: [voucher({ id: 'je-big' })],
      entries: [{ id: 'je-big', status: 'posted' }],
      lines: [line('je-big', '1510', 1688215.44, 0), line('je-big', '3105', 0, 1688215.44)],
      supplierRefs: [],
      customerRefs: [],
      foreignRows: [[{ id: 'inv-big', currency: 'EUR', total: 162973.57, subtotal: 162973.57, vat_amount: 0,
        total_sek: 1688000, exchange_rate: 10.3575 }]],
    })

    const result = await run([input({ invoiceId: 'inv-big', kind: 'customer', totalSek: 1688000, currencyCode: 'EUR' })], true)

    const rate = result.reports[0].sourceRate!.exchangeRate
    expect(rate).toBe(1688215.44 / 162973.57)
    expect(roundOre(162973.57 * rate)).toBe(1688215.44)
    expect(Math.round(162973.57 * rate * 100) / 100).toBe(1688215.44)
  })

  it('never uses the band to choose between several candidates for a series-less ref', async () => {
    // Two series carry number 329 dated with the invoice, both within 10% of
    // its SEK total: only an exact amount may pick one, so it stays ambiguous.
    queue({
      vouchers: [voucher({ id: 'je-a', series: 'A' }), voucher({ id: 'je-b', series: 'B' })],
      entries: [{ id: 'je-a', status: 'posted' }, { id: 'je-b', status: 'posted' }],
      lines: [...supplierLines('je-a', 11240), ...supplierLines('je-b', 11180)],
    })

    const result = await run([input({ invoiceId: 'si-1', sourceVoucher: { series: null, number: 329 }, totalSek: 11200,
      currencyCode: 'EUR' })])

    expect(result.ambiguous).toBe(1)
    expect(result.linked).toBe(0)
    expect(mock.calls.filter((c) => c.method === 'update')).toHaveLength(0)
  })
})

/**
 * Replacing a fiscal year by an SIE re-sync reverses every verifikat the
 * previous import brought in and imports the year again: each source ref is
 * then carried twice in that year, by the reversed first copy and by the live
 * second one. Every re-synced ref used to stop as ambiguous (hundreds of
 * customer invoices per company), and invoices an earlier run had
 * linked kept pointing at the reversed copies.
 */
describe('a fiscal year an SIE re-sync replaced', () => {
  beforeEach(() => {
    mock = createQueuedMockSupabase()
  })

  const reversedCopy = (over: Partial<Parameters<typeof voucher>[0]> = {}) =>
    voucher({ id: 'je-copy', series: 'B', number: 57, status: 'reversed', ...over })
  const liveCopy = (over: Partial<Parameters<typeof voucher>[0]> = {}) =>
    voucher({ id: 'je-live', series: 'B', number: 57, ...over })
  const customerInput = (over: Partial<MigratedInvoiceLinkInput> = {}) =>
    input({ invoiceId: 'inv-1', kind: 'customer', sourceVoucher: { series: 'B', number: 57 }, totalSek: 2500, ...over })

  it('resolves the live copy and links an unlinked invoice from NULL', async () => {
    queue({
      vouchers: [reversedCopy(), liveCopy()],
      entries: [{ id: 'je-live', status: 'posted' }],
      lines: customerLines('je-live', 2500),
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [{ id: 'inv-1' }] }],
    })

    const result = await run([customerInput()])

    expect(result.ambiguous).toBe(0)
    expect(result.reports[0]).toMatchObject({ outcome: 'linked', journalEntryId: 'je-live', reason: 'registration voucher linked' })
    expect(result.reports[0].replacesJournalEntryId).toBeUndefined()
    expect(updateChain('invoices')).toEqual(expect.arrayContaining([['is', ['journal_entry_id', null]]]))
    // The status the split rests on is read with the refs.
    expect(mock.calls.some((c) => c.table === 'journal_entries' && c.method === 'select'
      && String(c.args[0]).split(', ').includes('status'))).toBe(true)
  })

  it('moves the link of an invoice that still points at the reversed copy, and from that copy only', async () => {
    queue({
      vouchers: [reversedCopy(), liveCopy()],
      entries: [{ id: 'je-live', status: 'posted' }],
      lines: customerLines('je-live', 2500),
      supplierRefs: [],
      customerRefs: [{ id: 'inv-1', journal_entry_id: 'je-copy' }],
      updates: [{ data: [{ id: 'inv-1' }] }],
    })

    const result = await run([customerInput()])

    expect(result.linked).toBe(1)
    expect(result.reports[0]).toMatchObject({ outcome: 'linked', journalEntryId: 'je-live', replacesJournalEntryId: 'je-copy',
      reason: 'registration voucher linked in place of its reversed copy' })
    const [update] = updateCalls('invoices')
    expect(update.args[0]).toEqual({ journal_entry_id: 'je-live' })
    const chain = updateChain('invoices')
    expect(chain).toEqual(expect.arrayContaining([
      ['eq', ['id', 'inv-1']],
      ['eq', ['company_id', COMPANY]],
      ['eq', ['journal_entry_id', 'je-copy']],
      ['select', ['id']],
    ]))
    expect(chain).not.toContainEqual(['is', ['journal_entry_id', null]])
    // The copy's holders were read with the live entry's.
    expect(mock.findCalls('invoices', 'in')).toEqual(expect.arrayContaining([
      ['journal_entry_id', expect.arrayContaining(['je-live', 'je-copy'])],
    ]))
  })

  it('reports the move in a dry run, for the followup to write, and writes nothing', async () => {
    queue({
      vouchers: [reversedCopy(), liveCopy()],
      entries: [{ id: 'je-live', status: 'posted' }],
      lines: customerLines('je-live', 2500),
      supplierRefs: [],
      customerRefs: [{ id: 'inv-1', journal_entry_id: 'je-copy' }],
    })

    const result = await run([customerInput()], true)

    expect(result.reports[0]).toMatchObject({ outcome: 'linked', journalEntryId: 'je-live', replacesJournalEntryId: 'je-copy',
      reason: 'would move the link from its reversed copy (dry run)' })
    expect(mock.calls.filter((c) => c.method === 'update' || c.method === 'insert')).toHaveLength(0)
  })

  it('reports a moved link that no longer applies as alreadyLinked', async () => {
    queue({
      vouchers: [reversedCopy(), liveCopy()],
      entries: [{ id: 'je-live', status: 'posted' }],
      lines: customerLines('je-live', 2500),
      supplierRefs: [],
      customerRefs: [{ id: 'inv-1', journal_entry_id: 'je-copy' }],
      updates: [{ data: [] }],
    })

    const result = await run([customerInput()])

    expect(result.reports[0]).toMatchObject({ outcome: 'alreadyLinked', reason: 'invoice no longer points at the reversed copy' })
    expect(result.reports[0].replacesJournalEntryId).toBeUndefined()
  })

  it('leaves both links alone when another invoice holds the reversed copy', async () => {
    queue({
      vouchers: [reversedCopy(), liveCopy()],
      entries: [{ id: 'je-live', status: 'posted' }],
      lines: customerLines('je-live', 2500),
      supplierRefs: [],
      customerRefs: [{ id: 'inv-other', journal_entry_id: 'je-copy' }],
    })

    const result = await run([customerInput()])

    expect(result.reports[0]).toMatchObject({ outcome: 'alreadyLinked',
      reason: 'a reversed copy of the verifikat is the registration voucher of another invoice' })
    expect(updateCalls('invoices')).toHaveLength(0)
  })

  it('moves a supplier invoice\'s link the same way', async () => {
    queue({
      vouchers: [voucher({ id: 'je-copy', status: 'reversed' }), voucher({ id: 'je-live' })],
      entries: [{ id: 'je-live', status: 'posted' }],
      lines: supplierLines('je-live'),
      supplierRefs: [{ id: 'si-1', registration_journal_entry_id: 'je-copy' }],
      customerRefs: [],
      updates: [{ data: [{ id: 'si-1' }] }],
    })

    const result = await run([input({ invoiceId: 'si-1' })])

    expect(result.reports[0]).toMatchObject({ outcome: 'linked', journalEntryId: 'je-live', replacesJournalEntryId: 'je-copy' })
    expect(updateCalls('supplier_invoices')[0].args[0]).toEqual({ registration_journal_entry_id: 'je-live' })
    expect(updateChain('supplier_invoices')).toEqual(expect.arrayContaining([['eq', ['registration_journal_entry_id', 'je-copy']]]))
  })

  it('never takes a reversed copy from another fiscal year for this one\'s', async () => {
    // The same source ref a year earlier, reversed and linked to this invoice,
    // is not a copy of this year's verifikat: nothing moves.
    queue({
      vouchers: [reversedCopy({ period: 'period-2024', date: '2024-03-14' }), liveCopy()],
      entries: [{ id: 'je-live', status: 'posted' }],
      lines: customerLines('je-live', 2500),
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [] }],
    })

    const result = await run([customerInput()])

    expect(result.reports[0]).toMatchObject({ outcome: 'alreadyLinked', reason: 'invoice already carried a registration link' })
    expect(updateChain('invoices')).toEqual(expect.arrayContaining([['is', ['journal_entry_id', null]]]))
    expect(mock.findCalls('invoices', 'in')).toEqual([['journal_entry_id', ['je-live']]])
  })

  it('moves the link at the source rate for a foreign-currency invoice', async () => {
    queue({
      vouchers: [reversedCopy(), liveCopy()],
      entries: [{ id: 'je-live', status: 'posted' }],
      lines: [line('je-live', '1510', 4405, 0), line('je-live', '3105', 0, 4405)],
      supplierRefs: [],
      customerRefs: [{ id: 'inv-eur', journal_entry_id: 'je-copy' }],
      foreignRows: [[{ id: 'inv-eur', currency: 'EUR', total: 400, subtotal: 400, vat_amount: 0, total_sek: 4398, exchange_rate: 10.995 }]],
      updates: [{ data: [{ id: 'inv-eur' }] }],
    })

    const result = await run([customerInput({ invoiceId: 'inv-eur', totalSek: 4398, currencyCode: 'EUR' })])

    expect(result.reports[0]).toMatchObject({ outcome: 'linked', replacesJournalEntryId: 'je-copy',
      reason: 'registration voucher linked in place of its reversed copy at the source rate',
      sourceRate: { total: 400, totalSek: 4405, exchangeRate: 11.0125 } })
    expect(updateChain('invoices')).toEqual(expect.arrayContaining([
      ['eq', ['journal_entry_id', 'je-copy']],
      ['eq', ['total', 400]],
    ]))
  })

  it('reports a ref only reversed copies carry as unresolved, saying so', async () => {
    queue({ vouchers: [reversedCopy()] })

    const result = await run([customerInput()])

    expect(result.reports[0]).toMatchObject({ outcome: 'unresolved',
      reason: 'source ref B57 is carried only by reversed (storno) verifikat in that fiscal year' })
    expect(mock.supabase.from).toHaveBeenCalledTimes(2)
  })

  it('resolves a series-less ref past the reversed copy, and says so when only copies carry it', async () => {
    queue({
      vouchers: [reversedCopy(), liveCopy()],
      entries: [{ id: 'je-live', status: 'posted' }],
      lines: customerLines('je-live', 2500),
      supplierRefs: [],
      customerRefs: [],
      updates: [{ data: [{ id: 'inv-1' }] }],
    })
    const resolved = await run([customerInput({ sourceVoucher: { series: null, number: 57 } })])
    expect(resolved.reports[0]).toMatchObject({ outcome: 'linked', journalEntryId: 'je-live' })

    mock = createQueuedMockSupabase()
    queue({ vouchers: [reversedCopy()] })
    const copiesOnly = await run([customerInput({ sourceVoucher: { series: null, number: 57 } })])
    expect(copiesOnly.reports[0]).toMatchObject({ outcome: 'unresolved',
      reason: 'source number 57 is carried only by reversed (storno) verifikat in that fiscal year' })
  })

  it('keeps two live copies of one ref ambiguous, whatever is reversed beside them', async () => {
    queue({ vouchers: [reversedCopy(), liveCopy(), liveCopy({ id: 'je-live-2' })] })

    const result = await run([customerInput()])

    expect(result.ambiguous).toBe(1)
    expect(result.reports[0].reason).toContain('more than one verifikat')
    expect(mock.calls.filter((c) => c.method === 'update')).toHaveLength(0)
  })
})
