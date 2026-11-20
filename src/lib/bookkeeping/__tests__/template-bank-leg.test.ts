/**
 * crm#1321: a company's own mall applied to a bank transaction books the
 * accounts it was saved with; only its bank line moves to the transaction's
 * settlement ledger.
 *
 * A mall saved from a 1930 D / 1580 K payout had 1580 tagged "Betalning"
 * (the derivation's equal-amount tie went to the credit leg), and the bank
 * dialog rewrote whatever line carried that tag to the bank account: the
 * prefill came out 1930 D / 1930 K, which nets the bank to zero and which
 * commit_journal_entry refuses (BANK_BOOKING_SETTLEMENT_CHANGED). These
 * tests compose exactly what TransactionBookingDialog prefills
 * (applyTemplate, then templateBankLeg) and assert what that guard checks.
 */
import { describe, it, expect } from 'vitest'
import { applyTemplate } from '../template-library'
import { bankSideOf, templateBankLeg } from '../bank-leg'
import { roundOre } from '@/lib/money'
import type { BookingTemplateLibraryLine } from '@/types'

type Side = BookingTemplateLibraryLine['side']
type Type = BookingTemplateLibraryLine['type']

function line(account: string, side: Side, type: Type, extra: Partial<BookingTemplateLibraryLine> = {}): BookingTemplateLibraryLine {
  return { account, label: account, side, type, ratio: 1, ...extra }
}

/** What TransactionBookingDialog prefills: account and side per line. */
function prefill(lines: BookingTemplateLibraryLine[], transactionAmount: number, settlementAccount: string) {
  const form = applyTemplate(lines, Math.abs(transactionAmount))
  const bankLeg = templateBankLeg(lines, bankSideOf(transactionAmount), settlementAccount)
  return form.map((l, i) => ({
    ...l,
    account_number: i === bankLeg?.index && bankLeg.moves ? settlementAccount : l.account_number,
  }))
}

function accounts(form: ReturnType<typeof prefill>): string[] {
  return form.map((l) => `${l.account_number} ${l.debit_amount ? 'D' : 'K'}`)
}

/** The bank net commit_journal_entry compares with the transaction amount. */
function bankNet(form: ReturnType<typeof prefill>, settlementAccount: string): number {
  return roundOre(
    form
      .filter((l) => l.account_number === settlementAccount)
      .reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0) - (parseFloat(l.credit_amount) || 0), 0),
  )
}

describe('templateBankLeg: the mall books what was saved (crm#1321)', () => {
  // The reported mall as it is stored: derived from 1930 D / 1580 K with the
  // tie going to the credit leg.
  const payout = [line('1930', 'debit', 'business'), line('1580', 'credit', 'settlement')]

  it('books 1930 D / 1580 K on a payout into 1930, whatever leg is tagged Betalning', () => {
    const form = prefill(payout, 1488, '1930')
    expect(accounts(form)).toEqual(['1930 D', '1580 K'])
    expect(bankNet(form, '1930')).toBe(1488)
    expect(templateBankLeg(payout, 'debit', '1930')).toEqual({ index: 0, moves: false })
  })

  it('books the same with the tags the right way round', () => {
    const tagged = [line('1930', 'debit', 'settlement'), line('1580', 'credit', 'business')]
    expect(accounts(prefill(tagged, 1488, '1930'))).toEqual(['1930 D', '1580 K'])
  })

  it('moves the bank line, never the receivable, for a payout into another bank account', () => {
    const form = prefill(payout, 1488, '1931')
    expect(accounts(form)).toEqual(['1931 D', '1580 K'])
    expect(bankNet(form, '1931')).toBe(1488)
  })

  it('never rewrites a non-cash line of a mall that names a bank, on any line tagged Betalning', () => {
    // Saved from the default editor shape (debit Kostnad/Intäkt, credit
    // Betalning) with a revenue account as the payment.
    const revenue = [line('1930', 'debit', 'business'), line('3004', 'credit', 'settlement')]
    expect(accounts(prefill(revenue, 1200, '1930'))).toEqual(['1930 D', '3004 K'])
    // A mall with every line tagged Betalning: only the bank stays a bank.
    const allTagged = [
      line('4010', 'debit', 'settlement', { ratio: 0.5 }),
      line('6570', 'debit', 'settlement', { ratio: 0.5 }),
      line('1930', 'credit', 'settlement'),
    ]
    const form = prefill(allTagged, -1000, '1930')
    expect(accounts(form)).toEqual(['4010 D', '6570 D', '1930 K'])
    expect(bankNet(form, '1930')).toBe(-1000)
  })
})

describe('templateBankLeg: the 1930 placeholder keeps working', () => {
  const purchase = [
    line('5410', 'debit', 'business', { ratio: 0.8 }),
    line('2641', 'debit', 'vat', { vat_rate: 0.25, ratio: undefined }),
    line('1930', 'credit', 'settlement'),
  ]

  it('moves the mall bank line to the bank the purchase was paid from', () => {
    const form = prefill(purchase, -1000, '1932')
    expect(accounts(form)).toEqual(['5410 D', '2641 D', '1932 K'])
    expect(bankNet(form, '1932')).toBe(-1000)
  })

  it('leaves it on 1930 when the purchase was paid from 1930', () => {
    expect(templateBankLeg(purchase, 'credit', '1930')).toEqual({ index: 2, moves: false })
  })

  it('moves a bank line the old editor left tagged Kostnad/Intäkt (pre-#589 malls)', () => {
    const untagged = [line('5420', 'debit', 'business'), line('1930', 'credit', 'business')]
    expect(accounts(prefill(untagged, -250, '1931'))).toEqual(['5420 D', '1931 K'])
  })

  it('moves a 19xx line to a cash account kept outside 19xx (a 1686 balance)', () => {
    expect(accounts(prefill(purchase, -1000, '1686'))).toEqual(['5410 D', '2641 D', '1686 K'])
  })
})

describe('templateBankLeg: transfers between own accounts', () => {
  const toSavings = [line('1940', 'debit', 'business'), line('1930', 'credit', 'settlement')]

  it('books the transfer as saved from its 1930 end', () => {
    const form = prefill(toSavings, -5000, '1930')
    expect(accounts(form)).toEqual(['1940 D', '1930 K'])
    expect(bankNet(form, '1930')).toBe(-5000)
  })

  it('books the transfer as saved from its 1940 end, instead of 1940 against itself', () => {
    const form = prefill(toSavings, 5000, '1940')
    expect(accounts(form)).toEqual(['1940 D', '1930 K'])
    expect(bankNet(form, '1940')).toBe(5000)
  })

  it('moves the one bank line on the bank side for a third account', () => {
    expect(accounts(prefill(toSavings, -5000, '1931'))).toEqual(['1940 D', '1931 K'])
  })

  it('moves nothing when several bank lines sit on the bank side', () => {
    const split = [line('6991', 'debit', 'business'), line('1930', 'credit', 'settlement', { ratio: 0.5 }), line('1910', 'credit', 'business', { ratio: 0.5 })]
    expect(templateBankLeg(split, 'credit', '1931')).toBeNull()
  })
})

describe('templateBankLeg: a mall without a bank line', () => {
  // Saved for a purchase on credit or paid by the owner, then picked on a
  // bank row: the line tagged Betalning is the only one that can say where
  // the money moves, and as saved the bank would not move at all.
  const onAccount = [
    line('6230', 'debit', 'business', { ratio: 0.8 }),
    line('2640', 'debit', 'vat', { vat_rate: 0.25, ratio: undefined }),
    line('2440', 'credit', 'settlement'),
  ]

  it('moves the line tagged Betalning on the bank side to the bank', () => {
    const form = prefill(onAccount, -1000, '1930')
    expect(accounts(form)).toEqual(['6230 D', '2640 D', '1930 K'])
    expect(bankNet(form, '1930')).toBe(-1000)
  })

  it('moves nothing when the tagged line is not on the bank side', () => {
    expect(templateBankLeg(onAccount, 'debit', '1930')).toBeNull()
  })

  it('moves nothing when several lines on the bank side are tagged Betalning', () => {
    const twoTagged = [line('2710', 'debit', 'settlement'), line('2731', 'debit', 'business'), line('1630', 'credit', 'settlement')]
    expect(templateBankLeg(twoTagged, 'credit', '1930')).toEqual({ index: 2, moves: true })
    expect(templateBankLeg([...twoTagged, line('2510', 'credit', 'settlement')], 'credit', '1930')).toBeNull()
  })
})
