/**
 * Kontantmetoden partial payments: buildInvoiceCashPartialLines books one
 * installment of a never-booked customer invoice, revenue and utgående moms
 * per rate in proportion to the amount received. The installments must add up
 * to exactly what one payment of the whole invoice books (buildInvoiceCashLines),
 * per account and dimension bag, to the öre, however the invoice is split.
 */
import { describe, it, expect } from 'vitest'
import { buildCreditNoteItem } from '@/lib/invoices/build-credit-note-item'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput, Invoice, InvoiceItem } from '@/types'
import {
  buildCreditNoteLines,
  buildInvoiceCashLines,
  buildInvoiceCashPartialLines,
  type InvoiceCashPartialLines,
} from '../invoice-lines'

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    description: 'Konsulttjänst',
    quantity: 1,
    unit: 'st',
    unit_price: 987.65,
    line_total: 987.65,
    vat_rate: 25,
    vat_amount: 246.91,
    sort_order: 0,
    created_at: '2026-09-01',
    ...overrides,
  }
}

function invoiceWith(items: InvoiceItem[], overrides: Partial<Invoice> = {}): Invoice {
  const subtotal = roundOre(items.reduce((s, i) => s + i.line_total, 0))
  const vat = roundOre(items.reduce((s, i) => s + (i.vat_amount ?? 0), 0))
  return {
    id: 'inv-1',
    invoice_number: '2026-042',
    total: roundOre(subtotal + vat),
    total_sek: null,
    subtotal,
    subtotal_sek: null,
    vat_amount: vat,
    vat_amount_sek: null,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    deduction_total: 0,
    items,
    ...overrides,
  } as Invoice
}

// 987,65 + 246,91 moms = 1 234,56.
const singleRate = () => invoiceWith([item()])

// 25 %: 1 000 + 250; 12 %: 500 + 60; 6 %: 199,99 + 12 = 2 021,99.
const mixedRates = () =>
  invoiceWith([
    item({ id: 'a', line_total: 1000, unit_price: 1000, vat_rate: 25, vat_amount: 250 }),
    item({ id: 'b', line_total: 500, unit_price: 500, vat_rate: 12, vat_amount: 60 }),
    item({ id: 'c', line_total: 199.99, unit_price: 199.99, vat_rate: 6, vat_amount: 12 }),
  ])

const rows = (lines: CreateJournalEntryLineInput[]) =>
  lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

function ok(result: InvoiceCashPartialLines) {
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return result
}

function sideTotals(lines: CreateJournalEntryLineInput[]) {
  return {
    debit: roundOre(lines.reduce((s, l) => s + l.debit_amount, 0)),
    credit: roundOre(lines.reduce((s, l) => s + l.credit_amount, 0)),
  }
}

/** Net credit per account and dimension bag, settlement leg excluded. */
function netByCell(lines: CreateJournalEntryLineInput[], settlement = '1930') {
  const cells: Record<string, number> = {}
  for (const l of lines) {
    if (l.account_number === settlement) continue
    const key = `${l.account_number}|${JSON.stringify(l.dimensions ?? {})}`
    cells[key] = roundOre((cells[key] ?? 0) + l.credit_amount - l.debit_amount)
  }
  for (const key of Object.keys(cells)) if (cells[key] === 0) delete cells[key]
  return cells
}

/** Book the invoice in the given installments; returns every entry. */
function payInInstallments(invoice: Invoice, amounts: number[], settlement = '1930') {
  let paid = 0
  return amounts.map((amount) => {
    const entry = ok(
      buildInvoiceCashPartialLines(invoice, 'aktiebolag', { priorPaid: paid, amount }, 'Kund AB', settlement),
    )
    paid = entry.paidAfter
    return entry
  })
}

describe('buildInvoiceCashPartialLines', () => {
  it('books each installment pro rata and the three add up to the whole invoice', () => {
    const [first, second, last] = payInInstallments(singleRate(), [500, 400, 334.56])

    expect(rows(first.lines)).toEqual([
      ['1930', 500, 0],
      ['3001', 0, 400],
      ['2611', 0, 100],
    ])
    expect(first.settles).toBe(false)
    expect(first.paidAfter).toBe(500)
    expect(first.description).toBe('Kontant delbetalning kundfaktura 2026-042, Kund AB')

    expect(rows(second.lines)).toEqual([
      ['1930', 400, 0],
      ['3001', 0, 320],
      ['2611', 0, 80],
    ])

    expect(rows(last.lines)).toEqual([
      ['1930', 334.56, 0],
      ['3001', 0, 267.65],
      ['2611', 0, 66.91],
    ])
    expect(last.settles).toBe(true)
    expect(last.paidAfter).toBe(1234.56)
    expect(last.description).toBe('Kontant slutbetalning kundfaktura 2026-042, Kund AB')
  })

  it('reports what the earlier installments recognised, per account', () => {
    const [, second, last] = payInInstallments(singleRate(), [500, 400, 334.56])
    expect(second.recognisedBefore).toEqual({ '3001': 400, '2611': 100 })
    expect(last.recognisedBefore).toEqual({ '3001': 720, '2611': 180 })
  })

  it('reports nothing recognised before the first installment', () => {
    const [first] = payInInstallments(singleRate(), [500])
    expect(first.recognisedBefore).toEqual({ '3001': 0, '2611': 0 })
  })

  it('splits mixed rates per rate and lands every rate on its full amount', () => {
    const invoice = mixedRates()
    const entries = payInInstallments(invoice, [700, 0.01, 1000, 321.98])

    for (const entry of entries) {
      const { debit, credit } = sideTotals(entry.lines)
      expect(debit).toBe(credit)
    }
    const booked = netByCell(entries.flatMap((e) => e.lines))
    expect(booked).toEqual(netByCell(buildInvoiceCashLines(invoice, 'aktiebolag').lines))
    expect(booked).toEqual({
      '3001|{}': 1000,
      '2611|{}': 250,
      '3002|{}': 500,
      '2621|{}': 60,
      '3003|{}': 199.99,
      '2631|{}': 12,
    })
  })

  it('keeps every moms line of an installment within one öre of its exact share', () => {
    const invoice = mixedRates()
    const rates: Record<string, number> = { '2611': 250, '2621': 60, '2631': 12 }
    const amounts = [700, 0.01, 1000, 321.98]
    const entries = payInInstallments(invoice, amounts)
    entries.forEach((entry, i) => {
      for (const line of entry.lines.filter((l) => l.account_number in rates)) {
        const exact = (rates[line.account_number] * amounts[i]) / invoice.total
        expect(Math.abs(line.credit_amount - line.debit_amount - exact)).toBeLessThanOrEqual(0.01 + 1e-9)
      }
    })
  })

  it('books one payment of the whole invoice exactly like the whole-payment entry', () => {
    const invoice = mixedRates()
    const whole = ok(buildInvoiceCashPartialLines(invoice, 'aktiebolag', { priorPaid: 0, amount: invoice.total }))
    expect(rows(whole.lines)).toEqual(rows(buildInvoiceCashLines(invoice, 'aktiebolag').lines))
  })

  it('debits the settlement account the caller names', () => {
    const [first] = payInInstallments(singleRate(), [500], '1689')
    expect(first.lines[0]).toMatchObject({ account_number: '1689', debit_amount: 500, credit_amount: 0 })
  })

  it('splits a negative row (rabatt on its own account) on the debit side and nets it out', () => {
    const invoice = invoiceWith([
      item({ id: 'a', line_total: 1000, unit_price: 1000, vat_rate: 25, vat_amount: 250 }),
      item({
        id: 'b',
        line_total: -100,
        unit_price: -100,
        vat_rate: 25,
        vat_amount: -25,
        revenue_account: '3731',
      }),
    ])
    expect(invoice.total).toBe(1125)

    const entries = payInInstallments(invoice, [450, 675])
    expect(rows(entries[0].lines)).toEqual([
      ['1930', 450, 0],
      ['3001', 0, 400],
      ['3731', 40, 0],
      ['2611', 0, 90],
    ])
    expect(netByCell(entries.flatMap((e) => e.lines))).toEqual(
      netByCell(buildInvoiceCashLines(invoice, 'aktiebolag').lines),
    )
  })

  it('carries each revenue bucket its dimension bag and the settlement leg the invoice bag', () => {
    const invoice = invoiceWith(
      [
        item({ id: 'a', line_total: 600, unit_price: 600, vat_rate: 25, vat_amount: 150, dimensions: { '6': 'P1' } }),
        item({ id: 'b', line_total: 400, unit_price: 400, vat_rate: 25, vat_amount: 100, dimensions: { '6': 'P2' } }),
      ],
      { default_dimensions: { '1': 'K10' } } as Partial<Invoice>,
    )
    const entries = payInInstallments(invoice, [500, 750])
    expect(entries[0].lines.map((l) => [l.account_number, l.credit_amount + l.debit_amount, l.dimensions])).toEqual([
      ['1930', 500, { '1': 'K10' }],
      ['3001', 240, { '1': 'K10', '6': 'P1' }],
      ['3001', 160, { '1': 'K10', '6': 'P2' }],
      ['2611', 100, { '1': 'K10' }],
    ])
    expect(netByCell(entries.flatMap((e) => e.lines))).toEqual(
      netByCell(buildInvoiceCashLines(invoice, 'aktiebolag').lines),
    )
  })

  it('splits an invoice without loaded items from its header amounts', () => {
    const invoice = invoiceWith([], { subtotal: 800, vat_amount: 200, total: 1000, items: [] })
    const entries = payInInstallments(invoice, [333.33, 666.67])
    expect(rows(entries[0].lines)).toEqual([
      ['1930', 333.33, 0],
      ['3001', 0, 266.66],
      ['2611', 0, 66.67],
    ])
    expect(netByCell(entries.flatMap((e) => e.lines))).toEqual({ '3001|{}': 800, '2611|{}': 200 })
  })

  it('splits a reverse-charge invoice on its revenue account alone', () => {
    const invoice = invoiceWith(
      [item({ line_total: 2000, unit_price: 2000, vat_rate: 0, vat_amount: 0 })],
      { vat_treatment: 'reverse_charge' },
    )
    const [first] = payInInstallments(invoice, [500])
    expect(rows(first.lines)).toEqual([
      ['1930', 500, 0],
      ['3308', 0, 500],
    ])
  })

  it('telescopes for any split: every entry balances and the sum is the whole invoice', () => {
    // Deterministic pseudo-random invoices and splits (mulberry32).
    let seed = 20261003
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = seed
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const rates = [25, 12, 6, 0]
    for (let run = 0; run < 200; run++) {
      const items = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, i) => {
        const net = roundOre(1 + random() * 20000)
        const rate = rates[Math.floor(random() * rates.length)]
        return item({
          id: `i${i}`,
          line_total: net,
          unit_price: net,
          vat_rate: rate,
          vat_amount: roundOre((net * rate) / 100),
          dimensions: random() < 0.3 ? { '6': `P${i}` } : undefined,
        })
      })
      const invoice = invoiceWith(items)
      const amounts: number[] = []
      let left = invoice.total
      while (left > 0) {
        const amount = random() < 0.25 ? left : Math.min(left, roundOre(0.01 + random() * invoice.total * 0.6))
        amounts.push(amount)
        left = roundOre(left - amount)
      }

      const entries = payInInstallments(invoice, amounts)
      const whole = netByCell(buildInvoiceCashLines(invoice, 'aktiebolag').lines)
      entries.forEach((entry, i) => {
        const { debit, credit } = sideTotals(entry.lines)
        expect(debit).toBe(credit)
        expect(entry.lines[0].debit_amount).toBe(amounts[i])
        for (const line of entry.lines) {
          expect(line.debit_amount).toBeGreaterThanOrEqual(0)
          expect(line.credit_amount).toBeGreaterThanOrEqual(0)
        }
        // From one krona up, no installment puts a line on the other side
        // of the whole-payment entry (only the residual line could, and only
        // on a payment of a few öre).
        if (amounts[i] >= 1) {
          for (const [cell, net] of Object.entries(netByCell(entry.lines))) {
            expect(Math.sign(net)).toBe(Math.sign(whole[cell]))
          }
        }
      })
      expect(entries[entries.length - 1].settles).toBe(true)
      expect(netByCell(entries.flatMap((e) => e.lines))).toEqual(
        netByCell(buildInvoiceCashLines(invoice, 'aktiebolag').lines),
      )
    }
  })

  it('leaves nothing for a later credit note to over- or under-reverse', () => {
    // A credit note can follow a paid invoice (creditNoteNeedsJournalEntry),
    // never a part-paid one; it reverses the whole invoice, which the
    // installments must therefore have recognised exactly.
    const invoice = mixedRates()
    const entries = payInInstallments(invoice, [1000, 500, 521.99])
    const creditNote = {
      ...invoice,
      id: 'cn-1',
      invoice_number: 'KR-2026-042',
      total: -invoice.total,
      subtotal: -invoice.subtotal,
      vat_amount: -invoice.vat_amount,
      items: (invoice.items ?? []).map((i) => ({
        ...buildCreditNoteItem('cn-1', i),
        id: `cn-${i.id}`,
        created_at: i.created_at,
      })) as unknown as InvoiceItem[],
    } as Invoice
    const reversal = buildCreditNoteLines(creditNote, 'aktiebolag')
    const net = netByCell([...entries.flatMap((e) => e.lines), ...reversal], '1510')
    delete net['1930|{}']
    expect(net).toEqual({})
  })

  describe('refusals', () => {
    it('refuses a foreign-currency invoice', () => {
      const result = buildInvoiceCashPartialLines(
        invoiceWith([item()], { currency: 'EUR', exchange_rate: 11.5 }),
        'aktiebolag',
        { priorPaid: 0, amount: 100 },
      )
      expect(result).toEqual({ ok: false, reason: 'foreign_currency' })
    })

    it('refuses an invoice with a ROT/RUT deduction on the header', () => {
      const result = buildInvoiceCashPartialLines(
        invoiceWith([item()], { deduction_total: 300 } as Partial<Invoice>),
        'aktiebolag',
        { priorPaid: 0, amount: 100 },
      )
      expect(result).toEqual({ ok: false, reason: 'tax_deduction' })
    })

    it('refuses an invoice with a deduction on an item', () => {
      const result = buildInvoiceCashPartialLines(
        invoiceWith([item({ deduction_type: 'rot' } as Partial<InvoiceItem>)]),
        'aktiebolag',
        { priorPaid: 0, amount: 100 },
      )
      expect(result).toEqual({ ok: false, reason: 'tax_deduction' })
    })

    it('refuses an invoice whose lines do not add up to its total', () => {
      const result = buildInvoiceCashPartialLines(
        invoiceWith([item()], { total: 1300 }),
        'aktiebolag',
        { priorPaid: 0, amount: 100 },
      )
      expect(result).toEqual({ ok: false, reason: 'lines_do_not_match_total' })
    })

    it.each([
      ['a zero payment', 0, 0],
      ['a negative payment', 0, -10],
      ['more than what is owed', 1000, 234.57],
      ['an invoice already paid in full', 1234.56, 1],
      ['a negative prior payment', -1, 100],
    ])('refuses %s', (_label, priorPaid, amount) => {
      const result = buildInvoiceCashPartialLines(singleRate(), 'aktiebolag', { priorPaid, amount })
      expect(result).toEqual({ ok: false, reason: 'invalid_amount' })
    })
  })
})
