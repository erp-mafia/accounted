/**
 * A full kreditfaktura is the original turned around (accounted#58): the
 * credit note every door writes (buildCreditNoteFields + buildCreditNoteItem)
 * books, through buildCreditNoteLines, each of the original's registration
 * lines on the other side. The original and its credit then net to zero on
 * every account and dimension cell, a row that reduces the sale (a rabatt,
 * an öresavrundning downwards) included. Each row's absolute value used to be
 * negated instead, which credited such a row a second time: revenue and
 * moms reversed by more than was booked, 1510 by more than the credit note's
 * own total.
 */
import { describe, expect, it } from 'vitest'
import { buildCreditNoteLines, buildInvoiceRegistrationLines } from '../invoice-lines'
import { dimensionsBagKey } from '../dimension-resolver'
import { buildCreditNoteFields } from '@/lib/invoices/build-credit-note'
import { buildCreditNoteItem } from '@/lib/invoices/build-credit-note-item'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput, Invoice, InvoiceItem } from '@/types'

function row(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'row-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    description: 'Konsulttjänst',
    quantity: 1,
    unit: 'st',
    unit_price: 1000,
    line_total: 1000,
    vat_rate: 25,
    vat_amount: 250,
    created_at: '2026-09-01',
    ...overrides,
  }
}

/** An issued original whose header is what its rows add up to. */
function original(items: InvoiceItem[], overrides: Partial<Invoice> = {}): Invoice {
  const subtotal = roundOre(items.reduce((sum, item) => sum + item.line_total, 0))
  const vat = roundOre(items.reduce((sum, item) => sum + (item.vat_amount ?? 0), 0))
  return {
    id: 'inv-1',
    invoice_number: 'F-1',
    invoice_date: '2026-09-15',
    status: 'sent',
    document_type: 'invoice',
    currency: 'SEK',
    exchange_rate: null,
    subtotal,
    subtotal_sek: null,
    vat_amount: vat,
    vat_amount_sek: null,
    total: roundOre(subtotal + vat),
    total_sek: null,
    vat_treatment: 'standard_25',
    credited_invoice_id: null,
    default_dimensions: { '6': 'P1' },
    items,
    ...overrides,
  } as Invoice
}

/** The credit note exactly as createCreditNoteDraft writes it. */
function creditNoteOf(source: Invoice): Invoice {
  return {
    ...source,
    ...buildCreditNoteFields(source, { originalReference: 'F-1', today: '2026-10-19' }),
    id: 'cn-1',
    invoice_number: 'KR-F-1',
    items: (source.items ?? []).map((item) => ({ ...item, ...buildCreditNoteItem('cn-1', item) })),
  } as Invoice
}

/** Net (debit - credit) per account and dimension cell, zero cells dropped. */
function net(...entries: CreateJournalEntryLineInput[][]): Record<string, number> {
  const cells: Record<string, number> = {}
  for (const line of entries.flat()) {
    const key = `${line.account_number} ${dimensionsBagKey(line.dimensions ?? {})}`
    cells[key] = roundOre((cells[key] ?? 0) + line.debit_amount - line.credit_amount)
  }
  return Object.fromEntries(Object.entries(cells).filter(([, amount]) => amount !== 0))
}

function sides(lines: CreateJournalEntryLineInput[]) {
  return lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])
}

const SCENARIOS: Array<[string, Invoice]> = [
  ['a rabatt row on the same account', original([row(), row({ id: 'r', unit_price: -100, line_total: -100, vat_amount: -25 })])],
  ['a rabatt row on its own account', original([
    row({ revenue_account: '3041' }),
    row({ id: 'r', revenue_account: '3730', quantity: -1, unit_price: 200, line_total: -200, vat_amount: -50 }),
  ])],
  ['an öresavrundning row downwards', original([
    row({ line_total: 999.6, unit_price: 999.6, vat_amount: 249.9 }),
    row({ id: 'r', revenue_account: '3740', vat_rate: 0, unit_price: -0.5, line_total: -0.5, vat_amount: 0 }),
  ])],
  ['two rates, a negative row at 12 %, item dimensions', original([
    row({ dimensions: { '1': 'K1' } }),
    row({ id: 'b', vat_rate: 12, unit_price: 500, line_total: 500, vat_amount: 60, dimensions: { '1': 'K2' } }),
    row({ id: 'c', vat_rate: 12, unit_price: -50, line_total: -50, vat_amount: -6, dimensions: { '1': 'K2' } }),
  ])],
  ['ROT on the labour and a rabatt on the material', original([
    row({ revenue_account: '3041', quantity: 10, line_total: 10000, vat_amount: 2500, deduction_type: 'rot', deduction_amount: 3750 }),
    row({ id: 'm', unit_price: 2000, line_total: 2000, vat_amount: 500 }),
    row({ id: 'r', unit_price: -300, line_total: -300, vat_amount: -75 }),
  ], { deduction_total: 3750 })],
  ['EUR with a rabatt row', original([
    row({ unit_price: 100, line_total: 100, vat_amount: 25 }),
    row({ id: 'r', unit_price: -10, line_total: -10, vat_amount: -2.5 }),
  ], { currency: 'EUR', exchange_rate: 11.42, total_sek: 1284.75 })],
  ['no rows: the header fallback', original([], { subtotal: 900, vat_amount: 225, total: 1125 })],
]

describe('buildCreditNoteLines turns the original around (accounted#58)', () => {
  it.each(SCENARIOS)('%s: the original and its credit note net to zero on every cell', (_name, source) => {
    const registration = buildInvoiceRegistrationLines(source, 'aktiebolag')
    const credit = buildCreditNoteLines(creditNoteOf(source), 'aktiebolag', 'A-1')

    expect(net(registration, credit)).toEqual({})
    for (const line of credit) {
      expect(line.debit_amount).toBeGreaterThanOrEqual(0)
      expect(line.credit_amount).toBeGreaterThanOrEqual(0)
    }
  })

  it.each(SCENARIOS.filter(([, source]) => source.currency === 'SEK'))(
    '%s: 1510 takes off what the credit note says it credits',
    (_name, source) => {
      const creditNote = creditNoteOf(source)
      const credit = buildCreditNoteLines(creditNote, 'aktiebolag')
      const rows = creditNote.items ?? []
      const rowsTotal = roundOre(rows.reduce((sum, item) => sum + item.line_total + (item.vat_amount ?? 0), 0))
      if (rows.length > 0) expect(rowsTotal).toBe(creditNote.total)
      const receivable = credit
        .filter((l) => l.account_number === '1510' || l.account_number === '1513')
        .reduce((sum, l) => sum + l.credit_amount - l.debit_amount, 0)
      expect(roundOre(receivable)).toBe(-creditNote.total)
    },
  )

  it('the reported case: 1 000 and -100 at 25 % credit 900 revenue, 225 moms and 1 125 on 1510', () => {
    const credit = buildCreditNoteLines(creditNoteOf(SCENARIOS[0][1]), 'aktiebolag')
    expect(sides(credit)).toEqual([
      ['3001', 900, 0],
      ['2611', 225, 0],
      ['1510', 0, 1125],
    ])
  })

  it('a rabatt on its own account is credited back there, not debited a second time', () => {
    const credit = buildCreditNoteLines(creditNoteOf(SCENARIOS[1][1]), 'aktiebolag')
    expect(sides(credit)).toEqual([
      ['3041', 1000, 0],
      ['3730', 0, 200],
      ['2611', 200, 0],
      ['1510', 0, 1000],
    ])
  })

  it('a credit note stored before the fix (every row negative) books as it always did', () => {
    // Rows written with -Math.abs: the verifikat follows the stored rows.
    const stored = {
      ...creditNoteOf(SCENARIOS[1][1]),
      items: [
        row({ revenue_account: '3041', quantity: -1, line_total: -1000, vat_amount: -250 }),
        row({ id: 'r', revenue_account: '3730', quantity: -1, unit_price: 200, line_total: -200, vat_amount: -50 }),
      ],
    } as Invoice
    expect(sides(buildCreditNoteLines(stored, 'aktiebolag'))).toEqual([
      ['3041', 1000, 0],
      ['3730', 200, 0],
      ['2611', 300, 0],
      ['1510', 0, 1500],
    ])
  })
})
