import { describe, it, expect } from 'vitest'
import { computeProposalLines, proposalLinesToFormLines } from '../proposal-lines'

/**
 * "Ändra rader" opens the manual form on the lines the review showed. The
 * business line is the one that says what the money was for, so it carries
 * the review's own words; the money leg and the moms legs are named by their
 * accounts and stay empty.
 */
describe('proposalLinesToFormLines: the business line says what it was for', () => {
  const lines = computeProposalLines({
    amount: -45,
    amountSek: -45,
    category: 'expense_representation',
    accountOverride: '7631',
    vatTreatment: 'reduced_12',
  })

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
    const rc = computeProposalLines({
      amount: -100,
      amountSek: -100,
      templateDebitAccount: '6570',
      templateCreditAccount: '1930',
      templateVatTreatment: 'reverse_charge',
      templateVatRate: 0.25,
    })
    const form = proposalLinesToFormLines(rc, { businessLineDescription: 'Stripe-avgifter' })
    const described = form.filter((l) => l.line_description !== '').map((l) => l.account_number)
    expect(described).toEqual(['6570'])
  })
})
