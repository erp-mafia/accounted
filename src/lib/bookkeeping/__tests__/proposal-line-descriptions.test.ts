import { describe, it, expect } from 'vitest'
import { proposalLinesToFormLines, type ProposalLine } from '../proposal-lines'

/**
 * "Ändra rader" and Använd open the manual form on the lines the review
 * showed. Every line carries the review's own words for what the money was
 * for, the moms and reverse-charge basis legs too; the bank leg carries the
 * bank's text.
 */
describe('proposalLinesToFormLines: every line says what it was for', () => {
  // Intern representation at 12 %, as the preview answers it.
  const lines: ProposalLine[] = [
    { side: 'debet', account: '2641', amount: 4.82 },
    { side: 'debet', account: '7631', amount: 40.18 },
    { side: 'kredit', account: '1930', amount: 45, settlement: true },
  ]

  it('fills the business and moms lines, and the bank leg with the bank text', () => {
    const form = proposalLinesToFormLines(lines, { lineDescription: 'Intern representation', settlementLineDescription: 'Företagskonto' })
    const byAccount = Object.fromEntries(form.map((l) => [l.account_number, l.line_description]))
    expect(byAccount['7631']).toBe('Intern representation')
    expect(byAccount['2641']).toBe('Intern representation')
    expect(byAccount['1930']).toBe('Företagskonto')
  })

  it('leaves every line empty when the caller has no words for it', () => {
    expect(proposalLinesToFormLines(lines).every((l) => l.line_description === '')).toBe(true)
  })

  it('fills the reverse-charge moms and basis legs too', () => {
    const rc: ProposalLine[] = [
      { side: 'debet', account: '2645', amount: 25 },
      { side: 'kredit', account: '2614', amount: 25 },
      { side: 'debet', account: '4535', amount: 100 },
      { side: 'kredit', account: '4598', amount: 100 },
      { side: 'debet', account: '6570', amount: 100 },
      { side: 'kredit', account: '1930', amount: 100, settlement: true },
    ]
    const form = proposalLinesToFormLines(rc, { lineDescription: 'Stripe-avgifter' })
    const described = form.filter((l) => l.line_description === 'Stripe-avgifter').map((l) => l.account_number)
    expect(described).toEqual(['2645', '2614', '4535', '4598', '6570'])
  })
})
