import { describe, it, expect } from 'vitest'
import { booksBankLineInBankDirection, booksForeignAmountAsKronor, withBankLegCurrency } from '../bank-booking-context'
import { buildInvoiceMatchClearingLines } from '../invoice-payment-lines'
import { ledgerLineAmountIn } from '../ledger-line-amount'
import type { BankBookingContext, CreateJournalEntryLineInput } from '@/types'

const line = (account_number: string, debit_amount: number, credit_amount: number) =>
  ({ account_number, debit_amount, credit_amount })

describe('booksBankLineInBankDirection', () => {
  it('wants a credit on the bank ledger for a withdrawal', () => {
    expect(booksBankLineInBankDirection([line('6200', 500, 0), line('1930', 0, 500)], '1930', -500)).toBe(true)
    expect(booksBankLineInBankDirection([line('1930', 25000, 0), line('1933', 0, 25000)], '1930', -25000)).toBe(false)
  })

  it('wants a debit on the bank ledger for a deposit', () => {
    expect(booksBankLineInBankDirection([line('1930', 500, 0), line('3001', 0, 500)], '1930', 500)).toBe(true)
    expect(booksBankLineInBankDirection([line('6200', 500, 0), line('1930', 0, 500)], '1930', 500)).toBe(false)
  })

  it('refuses lines that never touch the bank ledger', () => {
    expect(booksBankLineInBankDirection([line('6200', 500, 0), line('1933', 0, 500)], '1930', -500)).toBe(false)
  })

  it('leaves a zero amount to the database', () => {
    expect(booksBankLineInBankDirection([line('6200', 0, 0)], '1930', 0)).toBe(true)
  })
})

describe('booksForeignAmountAsKronor (accounted#58)', () => {
  const noRate = { amount: -100, currency: 'EUR', amount_sek: null, exchange_rate: null }

  it('catches the prefill that books a rate-less EUR row 1:1 on the bank ledger', () => {
    expect(booksForeignAmountAsKronor([line('6200', 100, 0), line('1930', 0, 100)], '1930', noRate)).toBe(true)
    expect(booksForeignAmountAsKronor([line('1930', 250, 0), line('3001', 0, 250)], '1930', { ...noRate, amount: 250 })).toBe(true)
  })

  it('lets kronor typed from the bank statement through', () => {
    expect(booksForeignAmountAsKronor([line('6200', 1150, 0), line('1930', 0, 1150)], '1930', noRate)).toBe(false)
  })

  it('never fires for a row that carries a SEK value or is in SEK', () => {
    const lines = [line('6200', 100, 0), line('1930', 0, 100)]
    expect(booksForeignAmountAsKronor(lines, '1930', { ...noRate, amount_sek: -1150 })).toBe(false)
    expect(booksForeignAmountAsKronor(lines, '1930', { ...noRate, exchange_rate: 11.5 })).toBe(false)
    expect(booksForeignAmountAsKronor(lines, '1930', { ...noRate, currency: 'SEK' })).toBe(false)
    expect(booksForeignAmountAsKronor(lines, '1930', { ...noRate, currency: null })).toBe(false)
  })

  it('looks only at the bank ledger line', () => {
    expect(booksForeignAmountAsKronor([line('6200', 100, 0), line('1930', 0, 1150), line('3740', 0, -1050)], '1930', noRate)).toBe(false)
  })
})

describe('withBankLegCurrency (crm#1590)', () => {
  const ctx = (over: Partial<BankBookingContext> = {}): BankBookingContext => ({
    transaction_id: 'tx-1',
    cash_account_id: 'cash-1',
    settlement_account: '1940',
    date: '2026-10-20',
    amount: 2200,
    currency: 'EUR',
    ...over,
  })
  const sekLine = (account_number: string, debit_amount: number, credit_amount: number): CreateJournalEntryLineInput =>
    ({ account_number, debit_amount, credit_amount })

  it('stamps a EUR deposit on its bank debit line, kronor untouched', () => {
    const lines = [sekLine('1940', 24470.6, 0), sekLine('1510', 0, 24470.6)]
    const out = withBankLegCurrency(lines, [ctx()])
    expect(out[0]).toEqual({ ...lines[0], currency: 'EUR', amount_in_currency: 2200 })
    expect(out[1]).toBe(lines[1])
    // The caller's lines are not mutated.
    expect(lines[0]).not.toHaveProperty('currency')
  })

  it('stamps a withdrawal on its bank credit line as a magnitude', () => {
    const lines = [sekLine('2440', 618.75, 0), sekLine('1932', 0, 622.18), sekLine('7960', 3.43, 0)]
    const out = withBankLegCurrency(lines, [ctx({ settlement_account: '1932', amount: -56.75 })])
    expect(out[1]).toMatchObject({ credit_amount: 622.18, currency: 'EUR', amount_in_currency: 56.75 })
    expect(ledgerLineAmountIn(out[1], 'EUR')).toBe(-56.75)
  })

  it('returns the same lines for a SEK row, no context, or a zero amount', () => {
    const lines = [sekLine('1930', 100, 0), sekLine('3001', 0, 100)]
    expect(withBankLegCurrency(lines, [ctx({ currency: 'SEK', settlement_account: '1930', amount: 100 })])).toBe(lines)
    expect(withBankLegCurrency(lines, undefined)).toBe(lines)
    expect(withBankLegCurrency(lines, [])).toBe(lines)
    expect(withBankLegCurrency(lines, [ctx({ settlement_account: '1930', amount: 0 })])).toBe(lines)
  })

  it('keeps a figure the builder stamped itself (the categorize path)', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1940', debit_amount: 6800, credit_amount: 0, currency: 'EUR', amount_in_currency: 611.67, exchange_rate: 11.117 },
      sekLine('3001', 0, 6800),
    ]
    expect(withBankLegCurrency(lines, [ctx({ amount: 611.67 })])).toBe(lines)
  })

  it('stamps nothing when the bank side is split over two lines', () => {
    const lines = [sekLine('1940', 12000, 0), sekLine('1940', 12470.6, 0), sekLine('1510', 0, 24470.6)]
    expect(withBankLegCurrency(lines, [ctx()])).toBe(lines)
  })

  it('stamps nothing when two foreign rows share the account and side', () => {
    const lines = [sekLine('1940', 24470.6, 0), sekLine('1510', 0, 24470.6)]
    expect(withBankLegCurrency(lines, [ctx(), ctx({ transaction_id: 'tx-2', amount: 100 })])).toBe(lines)
  })

  it('the matched EUR payment reads 2200 EUR on the EUR account after the stamp (the reported symptom)', () => {
    const { lines } = buildInvoiceMatchClearingLines(
      { amount: 2200, amount_sek: 24470.6, currency: 'EUR', exchange_rate: 11.123 },
      {
        currency: 'EUR', exchange_rate: 11.1765, remaining_amount: 2200, total: 2200, paid_amount: 0,
        invoice_number: '1001', customer: null,
      },
      undefined,
      '1940',
    )
    const bankBefore = lines.find((l) => l.account_number === '1940')!
    expect(ledgerLineAmountIn(bankBefore, 'EUR')).toBeNull()
    const bankAfter = withBankLegCurrency(lines, [ctx()]).find((l) => l.account_number === '1940')!
    expect(ledgerLineAmountIn(bankAfter, 'EUR')).toBe(2200)
    expect(bankAfter.debit_amount).toBe(24470.6)
  })
})
