import { describe, it, expect } from 'vitest'
import { proposalLinesToFormLines, type ProposalLine } from '../proposal-lines'

/**
 * "Ändra rader" opens the manual form on the lines the review showed. The
 * business line is the one that says what the money was for, so it carries
 * the review's own words; the money leg and the moms legs are named by their
 * accounts and stay empty.
 */
describe('proposalLinesToFormLines: the business line says what it was for', () => {
  // Intern representation at 12 %, as the preview answers it.
  const lines: ProposalLine[] = [
    { side: 'debet', account: '2641', amount: 4.82 },
    { side: 'debet', account: '7631', amount: 40.18 },
    { side: 'kredit', account: '1930', amount: 45, settlement: true },
  ]

  it('fills the business line and leaves the moms and money legs alone', () => {
    const form = proposalLinesToFormLines(lines, { businessLineDescription: 'Intern representation' })
    const byAccount = Object.fromEntries(form.map((l) => [l.account_number, l.line_description]))
    expect(byAccount['7631']).toBe('Intern representation')
    expect(byAccount['2641']).toBe('')
    expect(byAccount['1930']).toBe('')
  })

  it('leaves every line empty when the caller has no words for it', () => {
    expect(proposalLinesToFormLines(lines).every((l) => l.line_description === '')).toBe(true)
  })

  it('keeps a reverse-charge basis leg out of the business lines', () => {
    const rc: ProposalLine[] = [
      { side: 'debet', account: '2645', amount: 25 },
      { side: 'kredit', account: '2614', amount: 25 },
      { side: 'debet', account: '4535', amount: 100 },
      { side: 'kredit', account: '4598', amount: 100 },
      { side: 'debet', account: '6570', amount: 100 },
      { side: 'kredit', account: '1930', amount: 100, settlement: true },
    ]
    const form = proposalLinesToFormLines(rc, { businessLineDescription: 'Stripe-avgifter' })
    const described = form.filter((l) => l.line_description !== '').map((l) => l.account_number)
    expect(described).toEqual(['6570'])
  })
})
