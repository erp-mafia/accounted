/**
 * Kontantmetoden bank match, öresavrundning (cash-bank-match-ore): the cash
 * entry books 1930 at what arrived on the bank row and the sub-krona gap to
 * the customer share on 3740, so 1930 follows the bank statement. Revenue
 * and moms stay on the invoice amounts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, Invoice, InvoiceItem } from '@/types'

vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn().mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'entry-1',
      ...input,
    }),
  ),
}))

const { createJournalEntry } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)
const { buildInvoiceCashLines, invoiceCashBankSek } = await import('../invoice-lines')
const { createInvoiceCashEntry } = await import('../invoice-entries')

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

// 987,65 + 246,91 moms = 1 234,56.
function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoice_number: '2026-042',
    total: 1234.56,
    total_sek: null,
    subtotal: 987.65,
    subtotal_sek: null,
    vat_amount: 246.91,
    vat_amount_sek: null,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    items: [item()],
    ...overrides,
  } as Invoice
}

const rows = (lines: CreateJournalEntryLineInput[]) =>
  lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

function balances(lines: CreateJournalEntryLineInput[]): boolean {
  const debit = lines.reduce((s, l) => s + l.debit_amount, 0)
  const credit = lines.reduce((s, l) => s + l.credit_amount, 0)
  return Math.round((debit - credit) * 100) === 0 && debit > 0
}

describe('buildInvoiceCashLines with a known bank amount', () => {
  it('paid over (1 235 on 1 234,56): 1930 takes the bank, 3740 credits the 0,44', () => {
    const { lines } = buildInvoiceCashLines(invoice(), 'aktiebolag', undefined, '1930', 1235)
    expect(rows(lines)).toEqual([
      ['1930', 1235, 0],
      ['3001', 0, 987.65],
      ['2611', 0, 246.91],
      ['3740', 0, 0.44],
    ])
    expect(balances(lines)).toBe(true)
  })

  it('paid short (1 234 on 1 234,56): 1930 takes the bank, 3740 debits the 0,56', () => {
    const { lines } = buildInvoiceCashLines(invoice(), 'aktiebolag', undefined, '1930', 1234)
    expect(rows(lines)).toEqual([
      ['1930', 1234, 0],
      ['3001', 0, 987.65],
      ['2611', 0, 246.91],
      ['3740', 0.56, 0],
    ])
    expect(balances(lines)).toBe(true)
  })

  it('exact payment: the entry is the one without a bank amount, no 3740', () => {
    const exact = buildInvoiceCashLines(invoice(), 'aktiebolag', undefined, '1930', 1234.56)
    expect(exact.lines).toEqual(buildInvoiceCashLines(invoice(), 'aktiebolag').lines)
    expect(exact.lines.some((l) => l.account_number === '3740')).toBe(false)
  })

  it('a gap of a krona or more is never rounding: the customer share is booked as before', () => {
    const before = buildInvoiceCashLines(invoice(), 'aktiebolag').lines
    expect(buildInvoiceCashLines(invoice(), 'aktiebolag', undefined, '1930', 1233.56).lines).toEqual(before)
    expect(buildInvoiceCashLines(invoice(), 'aktiebolag', undefined, '1930', 1236).lines).toEqual(before)
  })

  it('a foreign invoice ignores the bank amount: no 3740, unchanged entry', () => {
    const eur = invoice({
      currency: 'EUR',
      exchange_rate: 11.5,
      total: 125,
      subtotal: 100,
      vat_amount: 25,
      items: [item({ unit_price: 100, line_total: 100, vat_amount: 25 })],
    })
    const before = buildInvoiceCashLines(eur, 'aktiebolag').lines
    expect(buildInvoiceCashLines(eur, 'aktiebolag', undefined, '1930', 1437).lines).toEqual(before)
  })

  it('ROT: the customer share is what is owed, 1513 and the credits stay put', () => {
    // 1 002 labor + 250,50 moms = 1 252,50; ROT 30 % = 375,75; share 876,75.
    const rot = invoice({
      total: 1252.5,
      subtotal: 1002,
      vat_amount: 250.5,
      deduction_total: 375.75,
      items: [item({ unit_price: 1002, line_total: 1002, vat_amount: 250.5, deduction_type: 'rot' })],
    })
    const before = buildInvoiceCashLines(rot, 'aktiebolag').lines
    expect(before[0]).toMatchObject({ account_number: '1930', debit_amount: 876.75 })

    const { lines } = buildInvoiceCashLines(rot, 'aktiebolag', undefined, '1930', 877)
    expect(rows(lines)).toEqual([
      ['1930', 877, 0],
      ['1513', 375.75, 0],
      ['3001', 0, 1002],
      ['2611', 0, 250.5],
      ['3740', 0, 0.25],
    ])
    expect(balances(lines)).toBe(true)
  })

  it('the 3740 line carries the invoice bag like the other legs', () => {
    const tagged = invoice({ default_dimensions: { '6': 'P1' } })
    const { lines } = buildInvoiceCashLines(tagged, 'aktiebolag', undefined, '1930', 1235)
    expect(lines.find((l) => l.account_number === '3740')?.dimensions).toEqual({ '6': 'P1' })
  })
})

describe('invoiceCashBankSek', () => {
  it('is the SEK row amount, undefined for a foreign or missing row', () => {
    expect(invoiceCashBankSek({ amount: 1235, currency: 'SEK' })).toBe(1235)
    expect(invoiceCashBankSek({ amount: 107.39, currency: 'EUR' })).toBeUndefined()
    expect(invoiceCashBankSek(undefined)).toBeUndefined()
  })
})

describe('createInvoiceCashEntry books the bank row it is matched to', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const tx = { id: 'tx-1', cash_account_id: null, date: '2026-09-15', amount: 1235, currency: 'SEK' as const }

  it('a SEK bank row: 1930 is the row amount, 3740 the gap', async () => {
    await createInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice(), '2026-09-15', 'aktiebolag', undefined, '1930', tx,
    )
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.source_type).toBe('invoice_cash_payment')
    expect(rows(input.lines)).toEqual([
      ['1930', 1235, 0],
      ['3001', 0, 987.65],
      ['2611', 0, 246.91],
      ['3740', 0, 0.44],
    ])
  })

  it('no bank row (mark-paid): the customer share, no 3740', async () => {
    await createInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice(), '2026-09-15', 'aktiebolag')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines[0]).toMatchObject({ account_number: '1930', debit_amount: 1234.56 })
    expect(input.lines.some((l) => l.account_number === '3740')).toBe(false)
  })
})

describe('buildInvoiceCashLines with an overpayment account (crm#253)', () => {
  it('3740: 1930 takes the bank row, revenue and moms stay on the invoice, 3740 credits the excess', () => {
    const { lines } = buildInvoiceCashLines(invoice(), 'aktiebolag', undefined, '1930', 1240, '3740')
    expect(rows(lines)).toEqual([
      ['1930', 1240, 0],
      ['3001', 0, 987.65],
      ['2611', 0, 246.91],
      ['3740', 0, 5.44],
    ])
    expect(balances(lines)).toBe(true)
  })

  it('2420: any excess as an advance from the customer', () => {
    const { lines } = buildInvoiceCashLines(invoice(), 'aktiebolag', undefined, '1930', 2000, '2420')
    expect(rows(lines)).toContainEqual(['1930', 2000, 0])
    expect(rows(lines)).toContainEqual(['2420', 0, 765.44])
    expect(balances(lines)).toBe(true)
  })

  it('without an account, or 3740 at the cap, books the customer share as before', () => {
    for (const account of [undefined, '3740']) {
      const { lines } = buildInvoiceCashLines(invoice(), 'aktiebolag', undefined, '1930', 1244.56, account)
      expect(rows(lines)[0]).toEqual(['1930', 1234.56, 0])
      expect(lines.map((l) => l.account_number)).not.toContain('2420')
      expect(balances(lines)).toBe(true)
    }
  })
})
