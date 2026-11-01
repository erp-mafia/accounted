/**
 * Kontantmetoden bank match of a foreign-currency invoice (crm#1551): the
 * cash entry books the bank leg at the SEK that arrived on the matched row,
 * revenue and moms at the invoice's own rate, and the gap as the realised
 * kursvinst (3960) or kursförlust (7960). It used to book the bank leg at the
 * invoice's rate, so 1930 disagreed with the bank statement and no kursdiff
 * was booked.
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
const { buildInvoiceMatchClearingLines } = await import('../invoice-payment-lines')

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    description: 'Konsulttjänst',
    quantity: 1,
    unit: 'st',
    unit_price: 400,
    line_total: 400,
    vat_rate: 0,
    vat_amount: 0,
    sort_order: 0,
    created_at: '2026-10-01',
    ...overrides,
  }
}

// 400 EUR, tjänst till annat EU-land, booked at 11,2645: 4 505,80 kr.
function eurInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoice_number: '2026-101',
    total: 400,
    total_sek: null,
    subtotal: 400,
    subtotal_sek: null,
    vat_amount: 0,
    vat_amount_sek: null,
    currency: 'EUR',
    exchange_rate: 11.2645,
    vat_treatment: 'reverse_charge',
    items: [item()],
    ...overrides,
  } as Invoice
}

const rows = (lines: CreateJournalEntryLineInput[]) =>
  lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

function balances(lines: CreateJournalEntryLineInput[]): boolean {
  const debit = lines.reduce((s, l) => s + l.debit_amount, 0)
  const credit = lines.reduce((s, l) => s + l.credit_amount, 0)
  return Math.round((debit - credit) * 100) === 0 && debit > 0 && credit > 0
}

describe('buildInvoiceCashLines, foreign invoice with a known SEK bank amount', () => {
  it('bank below the invoice rate: 1930 takes the bank, revenue the invoice rate, 7960 the loss', () => {
    const { lines } = buildInvoiceCashLines(eurInvoice(), 'aktiebolag', undefined, '1930', 4393.89)
    expect(rows(lines)).toEqual([
      ['1930', 4393.89, 0],
      ['3308', 0, 4505.8],
      ['7960', 111.91, 0],
    ])
    expect(balances(lines)).toBe(true)
  })

  it('bank above the invoice rate: 3960 credits the gain', () => {
    const { lines } = buildInvoiceCashLines(eurInvoice(), 'aktiebolag', undefined, '1930', 4560.2)
    expect(rows(lines)).toEqual([
      ['1930', 4560.2, 0],
      ['3308', 0, 4505.8],
      ['3960', 0, 54.4],
    ])
    expect(balances(lines)).toBe(true)
  })

  it('moms stays at the invoice rate: only the bank leg and the kursdiff follow the bank', () => {
    // 100 EUR + 25 EUR moms at 11,50 = 1 437,50; 1 410,00 arrived.
    const standard = eurInvoice({
      total: 125,
      subtotal: 100,
      vat_amount: 25,
      exchange_rate: 11.5,
      vat_treatment: 'standard_25',
      items: [item({ unit_price: 100, line_total: 100, vat_rate: 25, vat_amount: 25 })],
    })
    const { lines } = buildInvoiceCashLines(standard, 'aktiebolag', undefined, '1930', 1410)
    const without = buildInvoiceCashLines(standard, 'aktiebolag', undefined, '1930').lines
    expect(lines.filter((l) => !['1930', '7960'].includes(l.account_number))).toEqual(
      without.filter((l) => l.account_number !== '1930'),
    )
    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe(1410)
    expect(lines.find((l) => l.account_number === '7960')?.debit_amount).toBe(27.5)
    expect(balances(lines)).toBe(true)
  })

  it('a bank amount equal to the invoice-rate share books no kursdiff', () => {
    const { lines } = buildInvoiceCashLines(eurInvoice(), 'aktiebolag', undefined, '1930', 4505.8)
    expect(lines).toEqual(buildInvoiceCashLines(eurInvoice(), 'aktiebolag', undefined, '1930').lines)
    expect(lines.some((l) => ['3960', '7960'].includes(l.account_number))).toBe(false)
  })

  it('never öresavrundning on a foreign invoice: a sub-krona gap is kursdiff, not 3740', () => {
    const { lines } = buildInvoiceCashLines(eurInvoice(), 'aktiebolag', undefined, '1930', 4505.5)
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
    expect(lines.find((l) => l.account_number === '7960')?.debit_amount).toBe(0.3)
  })

  it('the kursdiff line carries the invoice bag like the other legs', () => {
    const tagged = eurInvoice({ default_dimensions: { '6': 'P1' } })
    const { lines } = buildInvoiceCashLines(tagged, 'aktiebolag', undefined, '1930', 4393.89)
    expect(lines.find((l) => l.account_number === '7960')?.dimensions).toEqual({ '6': 'P1' })
  })

  it('books the same bank leg and kursdiff as the faktureringsmetoden clearing of the same payment', () => {
    const cash = buildInvoiceCashLines(eurInvoice(), 'aktiebolag', undefined, '1930', 4393.89).lines
    const clearing = buildInvoiceMatchClearingLines(
      { amount: 4393.89, amount_sek: null, currency: 'SEK', exchange_rate: null },
      { currency: 'EUR', exchange_rate: 11.2645, remaining_amount: 400, total: 400, paid_amount: 0, invoice_number: '2026-101' },
      400,
      '1930',
    ).lines
    const pick = (lines: CreateJournalEntryLineInput[], account: string) =>
      lines.find((l) => l.account_number === account)
    expect(pick(cash, '1930')?.debit_amount).toBe(pick(clearing, '1930')?.debit_amount)
    expect(pick(cash, '7960')?.debit_amount).toBe(pick(clearing, '7960')?.debit_amount)
  })
})

describe('createInvoiceCashEntry, foreign invoice matched to a bank row', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a SEK row (every match door: dashboard, v1, agent): 1930 is the row amount, 7960 the gap', async () => {
    const tx = { id: 'tx-1', cash_account_id: null, date: '2026-10-27', amount: 4393.89, currency: 'SEK' as const }
    await createInvoiceCashEntry(
      null as never, 'company-1', 'user-1', eurInvoice(), '2026-10-27', 'aktiebolag', undefined, '1930', tx,
    )
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.source_type).toBe('invoice_cash_payment')
    expect(rows(input.lines)).toEqual([
      ['1930', 4393.89, 0],
      ['3308', 0, 4505.8],
      ['7960', 111.91, 0],
    ])
    expect(balances(input.lines)).toBe(true)
  })

  it('no bank row (mark paid): the customer share at the invoice rate, as before', async () => {
    await createInvoiceCashEntry(
      null as never, 'company-1', 'user-1', eurInvoice(), '2026-10-27', 'aktiebolag', undefined, '1930',
    )
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(rows(input.lines)).toEqual([
      ['1930', 4505.8, 0],
      ['3308', 0, 4505.8],
    ])
  })

  it('a row on a foreign-currency account has no SEK amount here: unchanged entry', () => {
    expect(invoiceCashBankSek({ amount: 400, currency: 'EUR' })).toBeUndefined()
  })
})
