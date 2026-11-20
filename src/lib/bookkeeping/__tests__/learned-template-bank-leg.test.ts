/**
 * crm#1046: a learned counterparty template books its bank side on the
 * transaction's own settlement ledger, not the ledger it was learned on.
 *
 * A user with several currency accounts (1932 EUR, 1934 GBP, ...) learned a
 * card-fee template on the GBP account (debit 6570 / credit 1934). Replayed on
 * the same fee from the EUR account it booked credit 1934, and
 * commit_journal_entry refused it (BANK_BOOKING_SETTLEMENT_CHANGED): the
 * verifikat must move the transaction's own ledger on the bank side, credit
 * for an outflow and debit for an inflow. These tests go through the real
 * replay (buildMappingResultFromCounterpartyTemplate), the shared rewrite
 * (applySettlementAccount) and the real line assembly
 * (buildTransactionEntryLines), and assert exactly what that guard checks.
 */
import { describe, it, expect } from 'vitest'
import { makeTransaction, makeCategorizationTemplate } from '@/tests/helpers'
import {
  buildMappingResultFromCounterpartyTemplate,
  bindTemplateToSettlementAccount,
  type CounterpartyTemplateMatch,
} from '../counterparty-templates'
import { applySettlementAccount } from '../mapping-engine'
import { buildMappingResultFromCategory } from '../category-mapping'
import { buildTransactionEntryLines } from '../transaction-entries'
import { settleBankLeg, isCashLedger, bankSideOf } from '../bank-leg'
import { roundOre } from '@/lib/money'
import type { CategorizationTemplate, LinePatternEntry, Transaction } from '@/types'

const EUR_LEDGER = '1932'

function match(template: CategorizationTemplate): CounterpartyTemplateMatch {
  return { template, matchMethod: 'exact_normalized', confidence: 0.9 }
}

/** EUR transaction already converted to SEK, as a synced Wise row is. */
function eurTx(amount: number, amountSek: number): Transaction {
  return makeTransaction({
    amount,
    currency: 'EUR',
    amount_sek: amountSek,
    exchange_rate: Math.round((amountSek / amount) * 10000) / 10000,
    description: 'Card fee',
    merchant_name: 'Wise',
  })
}

/** Replay a learned template on a transaction and assemble the verifikat lines. */
function book(template: CategorizationTemplate, tx: Transaction, settlement: string) {
  const mapping = applySettlementAccount(
    buildMappingResultFromCounterpartyTemplate(match(template), tx, 'enskild_firma', true),
    settlement,
    tx.amount,
  )
  return { mapping, lines: buildTransactionEntryLines(tx, mapping) }
}

function sumDebit(lines: { debit_amount: number }[]): number {
  return roundOre(lines.reduce((s, l) => s + l.debit_amount, 0))
}
function sumCredit(lines: { credit_amount: number }[]): number {
  return roundOre(lines.reduce((s, l) => s + l.credit_amount, 0))
}

const feeLearnedOnGbp = () =>
  makeCategorizationTemplate({
    counterparty_name: 'wise card fee',
    debit_account: '6570',
    credit_account: '1934',
    vat_treatment: null,
    vat_account: null,
    category: 'expense_bank_fees',
  })

describe('learned template replayed on another of the company\'s cash accounts (crm#1046)', () => {
  it('outflow: the fee learned on 1934 credits the EUR ledger 1932, not 1934', () => {
    const tx = eurTx(-0.5, -5.48)
    const { mapping, lines } = book(feeLearnedOnGbp(), tx, EUR_LEDGER)

    expect(mapping.debit_account).toBe('6570')
    expect(mapping.credit_account).toBe(EUR_LEDGER)
    // What commit_journal_entry checks: a credit on the settlement ledger.
    expect(lines.some((l) => l.account_number === EUR_LEDGER && l.credit_amount > 0)).toBe(true)
    expect(lines.some((l) => l.account_number === '1934')).toBe(false)
    expect(sumDebit(lines)).toBe(sumCredit(lines))
    expect(sumDebit(lines)).toBe(5.48)
  })

  it('inflow (a refunded fee): the mirrored entry debits the EUR ledger 1932', () => {
    const tx = eurTx(0.5, 5.48)
    const { mapping, lines } = book(feeLearnedOnGbp(), tx, EUR_LEDGER)

    expect(mapping.direction_mismatch).toBe(true)
    expect(mapping.debit_account).toBe(EUR_LEDGER)
    expect(mapping.credit_account).toBe('6570')
    expect(lines.some((l) => l.account_number === EUR_LEDGER && l.debit_amount > 0)).toBe(true)
    expect(lines.some((l) => l.account_number === '1934')).toBe(false)
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('a multi-line pattern learned on 1934 settles on 1932, every other line untouched', () => {
    const pattern: LinePatternEntry[] = [
      { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
      { account: '6570', type: 'business', side: 'debit', ratio: 0.6 },
      { account: '6991', type: 'business', side: 'debit', ratio: 0.4 },
    ]
    const template = makeCategorizationTemplate({
      debit_account: '6570',
      credit_account: '1934',
      line_pattern: pattern,
    })
    const tx = eurTx(-100, -1095.5)
    const { lines } = book(template, tx, EUR_LEDGER)

    const settlement = lines.filter((l) => l.account_number === EUR_LEDGER)
    expect(settlement).toHaveLength(1)
    expect(settlement[0].credit_amount).toBe(1095.5)
    expect(lines.some((l) => l.account_number === '1934')).toBe(false)
    expect(lines.map((l) => l.account_number).sort()).toEqual(['1932', '2641', '6570', '6991'])
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('a multi-line pattern refund debits 1932 (mirrored)', () => {
    const pattern: LinePatternEntry[] = [
      { account: '6570', type: 'business', side: 'debit', ratio: 1 },
    ]
    const template = makeCategorizationTemplate({
      debit_account: '6570',
      credit_account: '1934',
      line_pattern: pattern,
      vat_treatment: null,
    })
    const tx = eurTx(20, 219.1)
    const { lines } = book(template, tx, EUR_LEDGER)

    expect(lines.find((l) => l.account_number === EUR_LEDGER)?.debit_amount).toBe(219.1)
    expect(lines.some((l) => l.account_number === '1934')).toBe(false)
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('is a no-op on the account the template was learned on', () => {
    const tx = makeTransaction({ amount: -6.5, currency: 'GBP', amount_sek: -85.3, exchange_rate: 13.1231 })
    const { mapping } = book(feeLearnedOnGbp(), tx, '1934')
    expect(mapping.debit_account).toBe('6570')
    expect(mapping.credit_account).toBe('1934')
  })
})

describe('own-account transfers keep their counter leg', () => {
  // Learned on a 1932 outflow: money moved from the EUR account to the GBP one.
  const transfer = () =>
    makeCategorizationTemplate({
      counterparty_name: 'wise transfer',
      debit_account: '1934',
      credit_account: '1932',
      vat_treatment: null,
      vat_account: null,
      category: null,
    })

  it('replayed on the account it was learned on: unchanged', () => {
    const tx = eurTx(-200, -2191)
    const { mapping, lines } = book(transfer(), tx, '1932')
    expect(mapping.debit_account).toBe('1934')
    expect(mapping.credit_account).toBe('1932')
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('replayed on a third account: the bank side moves, the counter 1934 stays', () => {
    const tx = makeTransaction({ amount: -2191, currency: 'SEK' })
    const { mapping } = book(transfer(), tx, '1935')
    expect(mapping.debit_account).toBe('1934')
    expect(mapping.credit_account).toBe('1935')
  })

  it('replayed from its other end (money back out of 1934): books 1934 to 1932, never 1934 against itself', () => {
    const tx = makeTransaction({ amount: -150, currency: 'GBP', amount_sek: -1968.5, exchange_rate: 13.1233 })
    const { mapping } = book(transfer(), tx, '1934')
    expect(mapping.debit_account).toBe('1932')
    expect(mapping.credit_account).toBe('1934')
  })

  it('the incoming leg on 1934 is already its bank side: unchanged', () => {
    const tx = makeTransaction({ amount: 150, currency: 'GBP', amount_sek: 1968.5, exchange_rate: 13.1233 })
    const { mapping } = book(transfer(), tx, '1934')
    expect(mapping.debit_account).toBe('1934')
    expect(mapping.credit_account).toBe('1932')
  })
})

describe('applySettlementAccount: the shared bank-leg rewrite', () => {
  it('still moves the 1930 placeholder of a category booking onto the settlement ledger', () => {
    const tx = makeTransaction({ amount: -29, currency: 'SEK' })
    const mapping = buildMappingResultFromCategory('expense_bank_fees', tx, true, 'enskild_firma')
    expect(mapping.credit_account).toBe('1930')
    expect(applySettlementAccount(mapping, '1940', tx.amount).credit_account).toBe('1940')
  })

  it('never rewrites a 1930 COUNTER leg (a transfer to the main account stays one)', () => {
    const transferToMain = {
      ...buildMappingResultFromCategory('expense_bank_fees', makeTransaction({ amount: -500 }), true, 'enskild_firma'),
      debit_account: '1930',
      credit_account: '1932',
    }
    const out = applySettlementAccount(transferToMain, '1932', -500)
    expect(out.debit_account).toBe('1930')
    expect(out.credit_account).toBe('1932')
  })

  it('leaves a non-cash money leg (2440) alone: that is a different booking, not a stale bank account', () => {
    const pair = { debit_account: '6570', credit_account: '2440' }
    expect(settleBankLeg(pair, 'credit', '1932')).toEqual(pair)
  })

  it('is a no-op when the bank leg already is the settlement ledger', () => {
    const pair = { debit_account: '6570', credit_account: '1930' }
    expect(settleBankLeg(pair, 'credit', '1930')).toBe(pair)
  })

  it('reads the bank side off the sign and cash ledgers off the BAS 19xx class', () => {
    expect(bankSideOf(-1)).toBe('credit')
    expect(bankSideOf(1)).toBe('debit')
    expect(isCashLedger('1934')).toBe(true)
    expect(isCashLedger('2440')).toBe(false)
    expect(isCashLedger('19')).toBe(false)
    expect(isCashLedger(null)).toBe(false)
  })
})

describe('bindTemplateToSettlementAccount: the proposal shows what will be booked', () => {
  it('an expense template learned on 1934 is offered on 1932 for an outflow and its refund alike', () => {
    const t = feeLearnedOnGbp()
    for (const amount of [-0.5, 0.5]) {
      const bound = bindTemplateToSettlementAccount(t, amount, EUR_LEDGER)
      expect(bound.debit_account).toBe('6570')
      expect(bound.credit_account).toBe(EUR_LEDGER)
    }
  })

  it('an income template keeps its revenue leg and moves its debit bank leg', () => {
    const t = makeCategorizationTemplate({ debit_account: '1934', credit_account: '3044' })
    const bound = bindTemplateToSettlementAccount(t, 1000, EUR_LEDGER)
    expect(bound.debit_account).toBe(EUR_LEDGER)
    expect(bound.credit_account).toBe('3044')
  })

  it('a transfer template keeps its counter leg, and the bound proposal books what the server books', () => {
    const t = makeCategorizationTemplate({ debit_account: '1934', credit_account: '1932', vat_treatment: null })
    const tx = makeTransaction({ amount: -150, currency: 'SEK' })
    const bound = bindTemplateToSettlementAccount(t, tx.amount, '1935')
    expect(bound.debit_account).toBe('1934')
    expect(bound.credit_account).toBe('1935')
    const booked = book(t, tx, '1935').mapping
    expect([booked.debit_account, booked.credit_account]).toEqual([bound.debit_account, bound.credit_account])
  })
})
