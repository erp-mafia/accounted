import { describe, it, expect } from 'vitest'
import { applyTemplate } from '../template-library'
import {
  balancingAmount,
  balancingAmountInput,
  checkTemplateLines,
  shownTemplateLines,
  templateLinesSeed,
  withLineAccount,
  withLineAmount,
  type TemplateEditLine,
} from '../template-line-edit'
import type { BookingTemplateLibraryLine } from '@/types'

// The crm#1351 shape: a sale paid out by a payment provider. The sale and its
// moms follow the total; the payout and the fee split the total by a share
// that differs every time, so the mall saves the fee at share 0.
const payoutMall: BookingTemplateLibraryLine[] = [
  { account: '3001', label: 'Försäljning', side: 'credit', type: 'business', ratio: 0.8 },
  { account: '2611', label: 'Utgående moms 25 %', side: 'credit', type: 'vat', vat_rate: 0.25 },
  { account: '1931', label: 'Betalväxel', side: 'debit', type: 'settlement', ratio: 1 },
  { account: '6041', label: 'Avgift', side: 'debit', type: 'business', ratio: 0 },
]

const line = (account: string, debit: string, credit: string): TemplateEditLine => ({
  account_number: account,
  debit_amount: debit,
  credit_amount: credit,
})

describe('templateLinesSeed / shownTemplateLines', () => {
  const computed = applyTemplate(payoutMall, 500)

  it('shows the mall lines until the person edits them', () => {
    expect(shownTemplateLines(computed, null, templateLinesSeed('m1', 500))).toBe(computed)
  })

  it('shows the edits while mall and total are the ones they were made on', () => {
    const seed = templateLinesSeed('m1', 500)
    const edited = withLineAmount(computed, 3, 'debit_amount', '12.50')
    expect(shownTemplateLines(computed, { seed, lines: edited }, seed)).toBe(edited)
  })

  it('computes the lines from the mall again for a new total or another mall', () => {
    const edited = withLineAmount(computed, 3, 'debit_amount', '12.50')
    const edits = { seed: templateLinesSeed('m1', 500), lines: edited }
    const recomputed = applyTemplate(payoutMall, 600)
    expect(shownTemplateLines(recomputed, edits, templateLinesSeed('m1', 600))).toBe(recomputed)
    expect(shownTemplateLines(computed, edits, templateLinesSeed('m2', 500))).toBe(computed)
  })

  it('treats totals that are the same to the öre as the same seed', () => {
    expect(templateLinesSeed('m1', 0.1 + 0.2)).toBe(templateLinesSeed('m1', 0.3))
  })
})

describe('withLineAmount / withLineAccount', () => {
  it('keeps one side per line: a figure on one side clears the other', () => {
    const lines = [line('6041', '', '10.00')]
    expect(withLineAmount(lines, 0, 'debit_amount', '4')[0]).toMatchObject({ debit_amount: '4', credit_amount: '' })
  })

  it('leaves the other side alone while the field is being cleared', () => {
    const lines = [line('6041', '4', '')]
    expect(withLineAmount(lines, 0, 'credit_amount', '')[0]).toMatchObject({ debit_amount: '4', credit_amount: '' })
  })

  it('changes only the edited line and never the input array', () => {
    const lines = applyTemplate(payoutMall, 500)
    const before = JSON.stringify(lines)
    const next = withLineAmount(lines, 3, 'debit_amount', '12.50')
    expect(JSON.stringify(lines)).toBe(before)
    expect(next[0]).toBe(lines[0])
    expect(next[3].debit_amount).toBe('12.50')
  })

  it('gives a new account its own text, the mall label named the old one', () => {
    const lines = applyTemplate(payoutMall, 500)
    const next = withLineAccount(lines, 3, '6570', 'Bankkostnader')
    expect(next[3]).toMatchObject({ account_number: '6570', line_description: 'Bankkostnader', debit_amount: '0.00' })
  })

  it('keeps the mall label when the same account is picked again', () => {
    const lines = applyTemplate(payoutMall, 500)
    expect(withLineAccount(lines, 3, '6041', 'Bankkostnader')[3]).toBe(lines[3])
  })
})

describe('balancingAmount', () => {
  it('fills the payout with what is left after the fee (the crm#1351 flow)', () => {
    let lines = applyTemplate(payoutMall, 193.19)
    lines = withLineAmount(lines, 3, 'debit_amount', '10.16')
    expect(balancingAmount(lines, 2, 'debit_amount')).toBe(183.03)
    expect(balancingAmountInput(lines, 2, 'debit_amount')).toBe('183.03')
  })

  it('is null when the gap belongs on the other side or there is none', () => {
    const lines = [line('1930', '100', ''), line('3001', '', '')]
    expect(balancingAmount(lines, 1, 'debit_amount')).toBeNull()
    expect(balancingAmount(lines, 1, 'credit_amount')).toBe(100)
    expect(balancingAmount([line('1930', '100', ''), line('3001', '', '100')], 1, 'credit_amount')).toBe(100)
    expect(balancingAmount([line('1930', '100', ''), line('3001', '', '100'), line('6570', '', '')], 2, 'debit_amount')).toBeNull()
  })

  it('sums in öre steps, without float drift', () => {
    const lines = [line('6071', '0.1', ''), line('6072', '0.2', ''), line('1930', '', '')]
    expect(balancingAmount(lines, 2, 'credit_amount')).toBe(0.3)
  })

  it('reads a comma decimal as typed', () => {
    const lines = [line('6071', '10,50', ''), line('1930', '', '')]
    expect(balancingAmount(lines, 1, 'credit_amount')).toBe(10.5)
  })
})

describe('checkTemplateLines', () => {
  it('is bookable as the mall computes it, leaving the share-0 line out', () => {
    const check = checkTemplateLines(applyTemplate(payoutMall, 193.19))
    expect(check.bookable).toBe(true)
    expect(check.totalDebit).toBe(193.19)
    expect(check.totalCredit).toBe(193.19)
    expect(check.postLines.map((l) => l.account_number)).toEqual(['3001', '2611', '1931'])
  })

  it('refuses to book while a fee is entered and the payout is not reduced', () => {
    const lines = withLineAmount(applyTemplate(payoutMall, 193.19), 3, 'debit_amount', '10.16')
    const check = checkTemplateLines(lines)
    expect(check.bookable).toBe(false)
    expect(check.difference).toBe(10.16)
  })

  it('books the edited lines once they balance, every amount on its own side', () => {
    let lines = applyTemplate(payoutMall, 193.19)
    lines = withLineAmount(lines, 3, 'debit_amount', '10.16')
    lines = withLineAmount(lines, 2, 'debit_amount', '183.03')
    const check = checkTemplateLines(lines)
    expect(check.bookable).toBe(true)
    expect(check.difference).toBe(0)
    expect(check.postLines).toEqual([
      { account_number: '3001', debit_amount: 0, credit_amount: 154.55, line_description: 'Försäljning' },
      { account_number: '2611', debit_amount: 0, credit_amount: 38.64, line_description: 'Utgående moms 25 %' },
      { account_number: '1931', debit_amount: 183.03, credit_amount: 0, line_description: 'Betalväxel' },
      { account_number: '6041', debit_amount: 10.16, credit_amount: 0, line_description: 'Avgift' },
    ])
  })

  it('holds back an amount without an account', () => {
    const check = checkTemplateLines([line('1930', '100', ''), line('3001', '', '80'), line('', '', '20')])
    expect(check.incomplete).toBe(1)
    expect(check.bookable).toBe(false)
  })

  it('holds back a figure that is not an amount, or below zero', () => {
    expect(checkTemplateLines([line('1930', '100', ''), line('3001', '', 'abc')]).bookable).toBe(false)
    const negative = checkTemplateLines([line('1930', '100', ''), line('3001', '', '120'), line('6570', '-20', '')])
    expect(negative.incomplete).toBe(1)
    expect(negative.bookable).toBe(false)
  })

  it('holds back a line with a figure on both sides', () => {
    const check = checkTemplateLines([line('1930', '100', ''), line('3001', '', '100'), line('6570', '5', '5')])
    expect(check.incomplete).toBe(1)
    expect(check.bookable).toBe(false)
  })

  it('needs two lines and a total above zero', () => {
    expect(checkTemplateLines([line('1930', '0', ''), line('3001', '', '0')]).bookable).toBe(false)
    expect(checkTemplateLines([line('1930', '', '')]).bookable).toBe(false)
  })

  it('leaves an empty added row out without holding the booking back', () => {
    const check = checkTemplateLines([line('1930', '100', ''), line('3001', '', '100'), line('', '', '')])
    expect(check.bookable).toBe(true)
    expect(check.postLines).toHaveLength(2)
  })

  it('posts the dimensions a mall set on its business line, through an edit of the amounts', () => {
    const mall: BookingTemplateLibraryLine[] = [
      { account: '5410', label: 'Förbrukning', side: 'debit', type: 'business', ratio: 1, dimensions: { '6': 'P001' } },
      { account: '1930', label: 'Bank', side: 'credit', type: 'settlement', ratio: 1 },
    ]
    let lines = applyTemplate(mall, 500)
    lines = withLineAmount(lines, 0, 'debit_amount', '480')
    lines = withLineAmount(lines, 1, 'credit_amount', '480')
    const check = checkTemplateLines(lines)
    expect(check.bookable).toBe(true)
    expect(check.postLines[0]).toEqual({
      account_number: '5410',
      debit_amount: 480,
      credit_amount: 0,
      line_description: 'Förbrukning',
      dimensions: { '6': 'P001' },
    })
    expect(check.postLines[1]).not.toHaveProperty('dimensions')
  })
})
