/**
 * The client half of the proposal preview: resolving a template's accounts
 * for the legal form, and handing proposal lines to the manual form. The
 * lines themselves are the server's (proposal-preview.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { proposalLinesToFormLines, resolveTemplateAccountsForEntity } from '@/lib/bookkeeping/proposal-lines'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import { roundOre } from '@/lib/money'

describe('resolveTemplateAccountsForEntity', () => {
  const template = {
    debit_account: '2013',
    credit_account: '1930',
    debit_account_ab: '2893',
  }

  it('keeps EF accounts for enskild firma', () => {
    expect(resolveTemplateAccountsForEntity(template, 'enskild_firma')).toEqual({
      debitAccount: '2013',
      creditAccount: '1930',
    })
  })

  it('translates the owner account to 2890 for an ideell förening', () => {
    expect(resolveTemplateAccountsForEntity(template, 'ideell_forening')).toEqual({
      debitAccount: '2890',
      creditAccount: '1930',
    })
  })

  it('substitutes AB accounts for aktiebolag, falling back per side', () => {
    expect(resolveTemplateAccountsForEntity(template, 'aktiebolag')).toEqual({
      debitAccount: '2893',
      creditAccount: '1930',
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

  it('swaps a literal-1930 settlement leg to the resolved cash account', () => {
    const formLines = proposalLinesToFormLines(lines, { settlementAccount: '1932' })
    expect(formLines[2].account_number).toBe('1932')
    // Non-settlement legs are never swapped
    expect(formLines[0].account_number).toBe('5420')
  })

  it('swaps a learned 19xx settlement leg to the resolved cash account (applySettlementAccount parity, crm#1046)', () => {
    // A counterparty template learned on another of the company's cash
    // accounts: the engine books the bank leg on the transaction's own ledger.
    const learned: ProposalLine[] = [
      { side: 'debet', account: '6570', amount: 5.48 },
      { side: 'kredit', account: '1934', amount: 5.48, settlement: true },
    ]
    const formLines = proposalLinesToFormLines(learned, { settlementAccount: '1932' })
    expect(formLines[1].account_number).toBe('1932')
    expect(formLines[0].account_number).toBe('6570')
  })

  it('never rewrites a learned non-cash settlement leg (applySettlementAccount parity)', () => {
    // A legacy counterparty template can settle against 2440 (payables):
    // the engine's applySettlementAccount moves only a cash-ledger bank leg,
    // so the prefill must keep the learned account too.
    const learned: ProposalLine[] = [
      { side: 'debet', account: '6212', amount: 100 },
      { side: 'kredit', account: '2440', amount: 100, settlement: true },
    ]
    const formLines = proposalLinesToFormLines(learned, { settlementAccount: '1932' })
    expect(formLines[1].account_number).toBe('2440')
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

  it('round-trips proposal lines into balanced form lines', () => {
    const formLines = proposalLinesToFormLines(lines, { settlementAccount: '1932' })
    const debits = formLines.reduce((s, l) => s + (l.debit_amount ? Number(l.debit_amount) : 0), 0)
    const credits = formLines.reduce((s, l) => s + (l.credit_amount ? Number(l.credit_amount) : 0), 0)
    expect(roundOre(debits)).toBe(roundOre(credits))
  })
})
