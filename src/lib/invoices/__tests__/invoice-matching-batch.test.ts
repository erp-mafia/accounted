/**
 * Batch invoice matching: one `loadInvoiceMatchPool()` per batch of bank rows,
 * then the pure `matchInvoiceCandidates()` per row.
 *
 * The fixture is served by a small in-memory Supabase that applies the
 * filters, order and range the loader sends, so the candidate narrowing
 * (quotes, credit notes, credited invoices, status-leaked paid invoices, other
 * companies) runs for real instead of being pre-baked into a mock result.
 */
import { describe, it, expect } from 'vitest'
import {
  bestInvoiceMatch,
  loadInvoiceMatchPool,
  matchInvoiceCandidates,
  type InvoiceMatchResult,
} from '../invoice-matching'
import { generateOcrReference } from '@/lib/bankgiro/luhn'
import type { Invoice, Transaction } from '@/types'
import { makeCustomer, makeInvoice, makeTransaction } from '@/tests/helpers'

type Row = Record<string, unknown>

/**
 * In-memory stand-in for the two reads the loader makes. Every read returns
 * fresh copies, like a real round trip, and every `from()` is counted.
 */
function createFixtureSupabase(tables: Record<string, Row[]>) {
  const fromCalls: string[] = []
  const from = (table: string) => {
    fromCalls.push(table)
    const filters: Array<(row: Row) => boolean> = []
    let orderBy: string | null = null
    let window: [number, number] | null = null
    const builder = {
      select: () => builder,
      eq: (col: string, value: unknown) => {
        filters.push((row) => row[col] === value)
        return builder
      },
      is: (col: string, value: unknown) => {
        filters.push((row) => (row[col] ?? null) === value)
        return builder
      },
      in: (col: string, values: readonly unknown[]) => {
        filters.push((row) => values.includes(row[col]))
        return builder
      },
      gte: (col: string, value: number) => {
        filters.push((row) => Number(row[col]) >= value)
        return builder
      },
      not: (col: string, op: string, value: unknown) => {
        if (op !== 'is') throw new Error(`fixture supabase: unsupported not(${op})`)
        filters.push((row) => (row[col] ?? null) !== value)
        return builder
      },
      order: (col: string) => {
        orderBy = col
        return builder
      },
      range: (start: number, end: number) => {
        window = [start, end]
        return builder
      },
      then: (resolve: (value: { data: Row[]; error: null }) => void) => {
        let rows = (tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)))
        if (orderBy) {
          const key = orderBy
          rows = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])))
        }
        if (window) rows = rows.slice(window[0], window[1] + 1)
        resolve({ data: structuredClone(rows), error: null })
      },
    }
    return builder
  }
  return { supabase: { from } as never, fromCalls }
}

const COMPANY = 'company-1'

const nordviken = makeCustomer({ id: 'cust-a', name: 'Nordviken Bygg AB' })
const fjallstugan = makeCustomer({ id: 'cust-b', name: 'Fjällstugan Konsult AB' })
const hamnkrogen = makeCustomer({ id: 'cust-c', name: 'Hamnkrogen AB' })

function invoiceRow(overrides: Partial<Invoice> & { customer?: unknown; credit_notes?: unknown }): Row {
  return {
    ...makeInvoice({ company_id: COMPANY, status: 'sent', currency: 'SEK', payment_cash_account_id: null, ...overrides }),
    customer: overrides.customer ?? null,
    credit_notes: overrides.credit_notes ?? [],
  } as Row
}

const invoices: Row[] = [
  // Three open invoices for the same amount: the tie-breaking cases.
  invoiceRow({ id: 'inv-01', invoice_number: '1001', total: 12500, remaining_amount: 12500, customer: nordviken }),
  invoiceRow({ id: 'inv-02', invoice_number: '1002', total: 12500, remaining_amount: 12500, customer: fjallstugan, payment_cash_account_id: 'ca-1931' }),
  invoiceRow({ id: 'inv-03', invoice_number: '1003', status: 'overdue', total: 12500, remaining_amount: 12500, customer: hamnkrogen }),
  // Partially paid: matched on what is left.
  invoiceRow({ id: 'inv-04', invoice_number: '1004', status: 'partially_paid', total: 20000, remaining_amount: 7500, customer: nordviken }),
  // Covered by a live credit note: never offered.
  invoiceRow({ id: 'inv-05', invoice_number: '1005', total: 8000, remaining_amount: 8000, customer: fjallstugan, credit_notes: [{ id: 'cn-06', status: 'sent', creation_complete: true }] }),
  // The credit note itself: never offered.
  invoiceRow({ id: 'cn-06', invoice_number: '1006', total: -8000, remaining_amount: -8000, credited_invoice_id: 'inv-05', customer: fjallstugan }),
  // Credit notes that do not count: cancelled, and one still being created.
  invoiceRow({ id: 'inv-07', invoice_number: '1007', total: 5000, remaining_amount: 5000, customer: hamnkrogen, credit_notes: [{ id: 'cn-x', status: 'cancelled', creation_complete: true }, { id: 'cn-y', status: 'draft', creation_complete: false }] }),
  // Status leak: still 'sent' but its payment voucher exists.
  invoiceRow({ id: 'inv-08', invoice_number: '1008', total: 3000, remaining_amount: 3000, customer: nordviken }),
  // EUR with a stored SEK conversion, and EUR without one.
  invoiceRow({ id: 'inv-09', invoice_number: '1009', currency: 'EUR', total: 1000, remaining_amount: 1000, total_sek: 11500, exchange_rate: 11.5, customer: fjallstugan }),
  invoiceRow({ id: 'inv-10', invoice_number: '1010', currency: 'EUR', total: 2000, remaining_amount: 2000, total_sek: null, exchange_rate: null, customer: fjallstugan }),
  // Legacy NULL currency means SEK.
  invoiceRow({ id: 'inv-11', invoice_number: '1011', status: 'overdue', currency: null as unknown as Invoice['currency'], total: 4000, remaining_amount: 4000, total_sek: 0 }),
  // Not receivables or not open: never offered.
  invoiceRow({ id: 'q-12', invoice_number: '1012', document_type: 'quote', total: 12500, remaining_amount: 12500 }),
  invoiceRow({ id: 'inv-13', invoice_number: '1013', status: 'paid', total: 12500, remaining_amount: 0 }),
  invoiceRow({ id: 'inv-14', invoice_number: '1014', status: 'draft', total: 12500, remaining_amount: 12500 }),
  // Fuzzy amount target.
  invoiceRow({ id: 'inv-15', invoice_number: '1015', total: 4950, remaining_amount: 4950, customer: hamnkrogen }),
  // Partially paid with an earlier payment voucher: still takes payments.
  invoiceRow({ id: 'inv-16', invoice_number: '1016', status: 'partially_paid', total: 10000, remaining_amount: 2500, customer: nordviken }),
  // Another company's invoice: never offered.
  invoiceRow({ id: 'inv-17', invoice_number: '1017', company_id: 'company-2', total: 12500, remaining_amount: 12500 }),
]

const invoicePayments: Row[] = [
  { id: 'pay-1', company_id: COMPANY, invoice_id: 'inv-08', journal_entry_id: 'je-1' },
  { id: 'pay-2', company_id: COMPANY, invoice_id: 'inv-01', journal_entry_id: null },
  { id: 'pay-3', company_id: COMPANY, invoice_id: 'inv-16', journal_entry_id: 'je-2' },
]

function bankRow(id: string, overrides: Partial<Transaction>): Transaction {
  return makeTransaction({
    id,
    company_id: COMPANY,
    description: 'Insättning',
    merchant_name: null,
    reference: null,
    currency: 'SEK',
    ...overrides,
  })
}

const batch: Transaction[] = [
  bankRow('t-01', { amount: 12500, reference: '1001' }),
  bankRow('t-02', { amount: 12500, reference: generateOcrReference('1002') }),
  bankRow('t-03', { amount: 12500, cash_account_id: 'ca-1931' }),
  bankRow('t-04', { amount: 12500, description: 'Betalning Hamnkrogen' }),
  bankRow('t-05', { amount: 7500, description: 'Nordviken delbetalning' }),
  bankRow('t-06', { amount: 6000, description: `Faktura ${generateOcrReference('1007')}` }),
  bankRow('t-07', { amount: 8000, description: 'Fjällstugan', reference: '1005' }),
  bankRow('t-08', { amount: 3000, description: 'Nordviken' }),
  bankRow('t-09', { amount: 11500 }),
  bankRow('t-10', { amount: 1000, currency: 'EUR' }),
  bankRow('t-11', { amount: 4000 }),
  bankRow('t-12', { amount: 4960, description: 'Hamnkrogen AB' }),
  bankRow('t-13', { amount: -12500, reference: '1001' }),
  bankRow('t-14', { amount: 2500 }),
  bankRow('t-15', { amount: 5000, description: 'Faktura 1007 Hamnkrogen' }),
  bankRow('t-16', { amount: 777 }),
]

const tables = () => ({ invoices, invoice_payments: invoicePayments })

/** What a caller acts on: invoice, score, reason, in order, plus the FX exclusions. */
function summarize(result: InvoiceMatchResult) {
  return {
    matches: result.matches.map((m) => [m.invoice.id, m.confidence, m.matchReason]),
    unconvertedFx: result.unconvertedFxInvoices.map((e) => e.invoiceId),
  }
}

const unconvertedEur = ['inv-10']

/**
 * The answers the per-transaction path (findInvoiceMatchCandidates, removed in
 * the commit that switched every caller to the batch path) gave on this
 * fixture. The commit before it ran both paths over this fixture and required
 * identical results, invoice rows included, and these exact answers.
 */
const expected: Record<string, ReturnType<typeof summarize>> = {
  't-01': { matches: [['inv-01', 0.99, 'OCR-referens matchar fakturanummer 1001']], unconvertedFx: [] },
  't-02': { matches: [['inv-02', 0.99, 'OCR-referens matchar fakturanummer 1002']], unconvertedFx: [] },
  't-03': {
    matches: [
      ['inv-02', 0.8, 'Exakt belopp (12500 SEK)'],
      ['inv-01', 0.8, 'Exakt belopp (12500 SEK)'],
      ['inv-03', 0.8, 'Exakt belopp (12500 SEK)'],
    ],
    unconvertedFx: unconvertedEur,
  },
  't-04': {
    matches: [
      ['inv-03', 0.95, 'Exakt belopp (12500 SEK) och kundnamn matchar'],
      ['inv-01', 0.8, 'Exakt belopp (12500 SEK)'],
      ['inv-02', 0.8, 'Exakt belopp (12500 SEK)'],
    ],
    unconvertedFx: unconvertedEur,
  },
  't-05': { matches: [['inv-04', 0.95, 'Exakt belopp (7500 SEK) och kundnamn matchar']], unconvertedFx: unconvertedEur },
  't-06': { matches: [['inv-07', 0.85, 'OCR-referens för faktura 1007 förekommer i banktexten']], unconvertedFx: unconvertedEur },
  't-07': { matches: [], unconvertedFx: unconvertedEur },
  't-08': { matches: [], unconvertedFx: unconvertedEur },
  't-09': { matches: [['inv-09', 0.8, 'Exakt belopp (11500 EUR)']], unconvertedFx: unconvertedEur },
  't-10': { matches: [['inv-09', 0.8, 'Exakt belopp (1000 EUR)']], unconvertedFx: [] },
  't-11': { matches: [['inv-11', 0.8, 'Exakt belopp (4000 null)']], unconvertedFx: unconvertedEur },
  // Two fuzzy candidates of the same customer at the same score: id order.
  't-12': {
    matches: [
      ['inv-07', 0.7, 'Belopp nära (±1%) och kundnamn matchar'],
      ['inv-15', 0.7, 'Belopp nära (±1%) och kundnamn matchar'],
    ],
    unconvertedFx: unconvertedEur,
  },
  't-13': { matches: [], unconvertedFx: [] },
  't-14': { matches: [['inv-16', 0.8, 'Exakt belopp (2500 SEK)']], unconvertedFx: unconvertedEur },
  't-15': { matches: [['inv-07', 0.95, 'Exakt belopp (5000 SEK) och kundnamn matchar']], unconvertedFx: unconvertedEur },
  't-16': { matches: [], unconvertedFx: unconvertedEur },
}

describe('batch invoice matching', () => {
  it('gives every row of the batch the answer the per-transaction path gave', async () => {
    const { supabase } = createFixtureSupabase(tables())
    const pool = await loadInvoiceMatchPool(supabase, COMPANY)
    const before = structuredClone(pool)

    for (const tx of batch) {
      const result = matchInvoiceCandidates(tx, pool)
      expect(summarize(result), tx.id).toEqual(expected[tx.id])
      expect(result.unconvertedFxCount, tx.id).toBe(expected[tx.id].unconvertedFx.length)

      for (const threshold of [undefined, 0.5, 0.9]) {
        const [top] = expected[tx.id].matches
        const wanted = top && (top[1] as number) >= (threshold ?? 0.8) ? top[0] : null
        expect(bestInvoiceMatch(tx, pool, threshold)?.invoice.id ?? null, `${tx.id} @ ${threshold}`).toBe(wanted)
      }
    }

    // Scoring is pure: the pool every row shares comes out as it went in.
    expect(pool).toEqual(before)
  })

  it('reads invoices and payment vouchers once per batch, not once per row', async () => {
    // The per-transaction path read both tables for every income row: 2 x 15
    // = 30 reads for this batch. The batch path reads them once.
    const { supabase, fromCalls } = createFixtureSupabase(tables())
    const pool = await loadInvoiceMatchPool(supabase, COMPANY)
    for (const tx of batch) matchInvoiceCandidates(tx, pool)
    expect(fromCalls).toEqual(['invoices', 'invoice_payments'])
  })

  it('pages the invoice read in a stable id order', async () => {
    const { supabase } = createFixtureSupabase(tables())
    const pool = await loadInvoiceMatchPool(supabase, COMPANY)
    const ids = pool.invoices.map((inv) => inv.id)
    expect(ids).toEqual([...ids].sort())
    expect(ids).toEqual(['inv-01', 'inv-02', 'inv-03', 'inv-04', 'inv-07', 'inv-09', 'inv-10', 'inv-11', 'inv-15', 'inv-16'])
  })
})
