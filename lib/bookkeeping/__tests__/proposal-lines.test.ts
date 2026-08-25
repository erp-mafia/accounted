import { describe, it, expect } from 'vitest'
import { computeProposalLines, proposalLinesToFormLines } from '@/lib/bookkeeping/proposal-lines'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import { roundOre } from '@/lib/money'
import type { LinePatternEntry } from '@/types'

function sumSide(lines: ProposalLine[], side: 'debet' | 'kredit'): number {
  return roundOre(lines.filter(l => l.side === side).reduce((s, l) => s + l.amount, 0))
}

describe('computeProposalLines', () => {
  describe('category branch (AI suggestion / category booking)', () => {
    it('builds expense lines with extracted VAT and marks the bank leg as settlement', () => {
      const lines = computeProposalLines({
        amount: -123.45,
        category: 'expense_software',
        vatTreatment: 'standard_25',
      })
      // net 98.76 + VAT 24.69 = 123.45 (ore rounding preserved)
      expect(lines).toEqual([
        { side: 'debet', account: '5420', amount: 98.76 },
        { side: 'debet', account: '2641', amount: 24.69 },
        { side: 'kredit', account: '1930', amount: 123.45, settlement: true },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('applies the account override on the non-bank side (what the AI proposal edits)', () => {
      const lines = computeProposalLines({
        amount: -100,
        category: 'expense_software',
        vatTreatment: 'standard_25',
        accountOverride: '4010',
      })
      expect(lines[0]).toEqual({ side: 'debet', account: '4010', amount: 80 })
      // The bank leg keeps the settlement flag, never the override
      expect(lines[2]).toEqual({ side: 'kredit', account: '1930', amount: 100, settlement: true })
    })

    it('builds income lines with output VAT and settlement on the debit bank leg', () => {
      const lines = computeProposalLines({
        amount: 106,
        category: 'income_services',
        vatTreatment: 'reduced_6',
      })
      expect(lines).toEqual([
        { side: 'debet', account: '1930', amount: 106, settlement: true },
        { side: 'kredit', account: '2631', amount: 6 },
        { side: 'kredit', account: '3003', amount: 100 },
      ])
    })

    it('uses the SEK-equivalent magnitude for foreign-currency transactions', () => {
      const lines = computeProposalLines({
        amount: -100, // EUR
        amountSek: 1150,
        category: 'expense_other',
        vatTreatment: 'standard_25',
      })
      const bank = lines.find(l => l.settlement)
      expect(bank).toEqual({ side: 'kredit', account: '1930', amount: 1150, settlement: true })
      expect(sumSide(lines, 'debet')).toBe(1150)
    })

    it('adds the reverse-charge offsetting pair for category expenses', () => {
      const lines = computeProposalLines({
        amount: -1000,
        category: 'expense_other',
        vatTreatment: 'reverse_charge',
      })
      expect(lines).toContainEqual({ side: 'debet', account: '2645', amount: 250 })
      expect(lines).toContainEqual({ side: 'kredit', account: '2614', amount: 250 })
    })

    it('returns no lines without a category', () => {
      expect(computeProposalLines({ amount: -100 })).toEqual([])
    })
  })

  describe('template branch (static review template)', () => {
    it('builds an expense from debit/credit pair with VAT rate', () => {
      const lines = computeProposalLines({
        amount: -125,
        templateDebitAccount: '6212',
        templateCreditAccount: '1930',
        templateVatRate: 0.25,
      })
      expect(lines).toEqual([
        { side: 'debet', account: '6212', amount: 100 },
        { side: 'debet', account: '2641', amount: 25 },
        { side: 'kredit', account: '1930', amount: 125, settlement: true },
      ])
    })

    it('builds an income booking with rate-mapped output VAT account', () => {
      const lines = computeProposalLines({
        amount: 112,
        templateDebitAccount: '1930',
        templateCreditAccount: '3002',
        templateVatRate: 0.12,
      })
      expect(lines).toEqual([
        { side: 'debet', account: '1930', amount: 112, settlement: true },
        { side: 'kredit', account: '3002', amount: 100 },
        { side: 'kredit', account: '2621', amount: 12 },
      ])
    })

    it('builds the full reverse-charge verifikation incl. fiktiv moms and basbelopp pairs', () => {
      const lines = computeProposalLines({
        amount: -1000,
        templateDebitAccount: '6540',
        templateCreditAccount: '1930',
        templateVatRate: 0,
        templateVatTreatment: 'reverse_charge',
        templateSupplierType: 'eu_business',
      })
      expect(lines).toEqual([
        { side: 'debet', account: '6540', amount: 1000 },
        { side: 'kredit', account: '1930', amount: 1000, settlement: true },
        { side: 'debet', account: '2645', amount: 250 },
        { side: 'kredit', account: '2614', amount: 250 },
        { side: 'debet', account: '4535', amount: 1000 },
        { side: 'kredit', account: '4598', amount: 1000 },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('skips the basbelopp pair when the debit account is already a basis account', () => {
      const lines = computeProposalLines({
        amount: -1000,
        templateDebitAccount: '4535',
        templateCreditAccount: '1930',
        templateVatTreatment: 'reverse_charge',
        templateSupplierType: 'eu_business',
      })
      expect(lines.map(l => l.account)).toEqual(['4535', '1930', '2645', '2614'])
    })
  })

  describe('line pattern branch (counterparty template)', () => {
    const pattern: LinePatternEntry[] = [
      { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
      { account: '6212', type: 'business', side: 'debit', ratio: 1 },
    ]

    it('builds settlement + VAT + business lines from the pattern', () => {
      const lines = computeProposalLines({ amount: -1000, linePattern: pattern })
      expect(lines).toEqual([
        { side: 'kredit', account: '1930', amount: 1000, settlement: true },
        { side: 'debet', account: '2641', amount: 200 },
        { side: 'debet', account: '6212', amount: 800 },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('respects a custom settlement account', () => {
      const lines = computeProposalLines({ amount: -1000, linePattern: pattern, settlementAccount: '1932' })
      expect(lines[0]).toEqual({ side: 'kredit', account: '1932', amount: 1000, settlement: true })
    })

    it('books the ore rounding difference on 3740', () => {
      const multi: LinePatternEntry[] = [
        { account: '6110', type: 'business', side: 'debit', ratio: 0.333 },
        { account: '6212', type: 'business', side: 'debit', ratio: 0.333 },
        { account: '6991', type: 'business', side: 'debit', ratio: 0.333 },
      ]
      const lines = computeProposalLines({ amount: -100, linePattern: multi })
      // 3 x 33.30 = 99.90, diff 0.10 lands on 3740 on the business side
      expect(lines).toContainEqual({ side: 'debet', account: '3740', amount: 0.1 })
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('handles income patterns with the settlement on the debit side', () => {
      const incomePattern: LinePatternEntry[] = [
        { account: '2611', type: 'vat', side: 'credit', vat_rate: 0.25 },
        { account: '3001', type: 'business', side: 'credit', ratio: 1 },
      ]
      const lines = computeProposalLines({ amount: 1250, linePattern: incomePattern })
      expect(lines).toEqual([
        { side: 'debet', account: '1930', amount: 1250, settlement: true },
        { side: 'kredit', account: '2611', amount: 250 },
        { side: 'kredit', account: '3001', amount: 1000 },
      ])
    })
  })
})

describe('proposalLinesToFormLines', () => {
  const lines: ProposalLine[] = [
    { side: 'debet', account: '5420', amount: 98.76 },
    { side: 'debet', account: '2641', amount: 24.69 },
    { side: 'kredit', account: '1930', amount: 123.45, settlement: true },
  ]

  it('maps sides to debit/credit strings with two-decimal formatting', () => {
    const formLines = proposalLinesToFormLines(lines)
    expect(formLines).toEqual([
      { account_number: '5420', debit_amount: '98.76', credit_amount: '', line_description: '' },
      { account_number: '2641', debit_amount: '24.69', credit_amount: '', line_description: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '123.45', line_description: '' },
    ])
  })

  it('formats whole amounts with trailing zeros', () => {
    const formLines = proposalLinesToFormLines([{ side: 'debet', account: '6212', amount: 100 }])
    expect(formLines[0].debit_amount).toBe('100.00')
  })

  it('swaps the settlement leg to the resolved cash account', () => {
    const formLines = proposalLinesToFormLines(lines, { settlementAccount: '1932' })
    expect(formLines[2].account_number).toBe('1932')
    // Non-settlement legs are never swapped
    expect(formLines[0].account_number).toBe('5420')
  })

  it('stamps currency metadata on the settlement leg only', () => {
    const formLines = proposalLinesToFormLines(lines, {
      settlementAccount: '1930',
      currency: 'EUR',
      foreignAmount: 10.5,
      exchangeRate: 11.7571,
    })
    expect(formLines[2]).toMatchObject({
      account_number: '1930',
      currency: 'EUR',
      amount_in_currency: 10.5,
      exchange_rate: 11.7571,
    })
    expect(formLines[0]).not.toHaveProperty('currency')
    expect(formLines[1]).not.toHaveProperty('currency')
  })

  it('adds no currency metadata for SEK transactions', () => {
    const formLines = proposalLinesToFormLines(lines, { settlementAccount: '1930', currency: 'SEK' })
    expect(formLines[2]).not.toHaveProperty('currency')
    expect(formLines[2]).not.toHaveProperty('amount_in_currency')
  })

  it('round-trips a computed proposal into balanced form lines', () => {
    const computed = computeProposalLines({
      amount: -123.45,
      category: 'expense_software',
      vatTreatment: 'standard_25',
    })
    const formLines = proposalLinesToFormLines(computed, { settlementAccount: '1932' })
    const debits = formLines.reduce((s, l) => s + (l.debit_amount ? Number(l.debit_amount) : 0), 0)
    const credits = formLines.reduce((s, l) => s + (l.credit_amount ? Number(l.credit_amount) : 0), 0)
    expect(roundOre(debits)).toBe(roundOre(credits))
  })
})
