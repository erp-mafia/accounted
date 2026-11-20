import { describe, expect, it } from 'vitest'
import {
  bankRowFacts,
  factsFromLines,
  grantCounterpartyKey,
  matchBookingReviewRules,
  ruleMatches,
  vatClassesFromLines,
  vatClassesOfTreatment,
  type BookingReviewFacts,
  type BookingReviewRule,
} from '../match'
import { markBlockedProposals, proposalFacts } from '../proposals'
import type { BookingProposal } from '@/lib/bookkeeping/proposal'

function rule(overrides: Partial<BookingReviewRule> = {}): BookingReviewRule {
  return {
    id: 'r-1',
    rule_id: 'r-1',
    version: 1,
    accounts: null,
    counterparty_key: null,
    counterparty_label: null,
    amount_from_sek: null,
    vat_treatment: null,
    note: null,
    valid_from: '2026-10-29T00:00:00Z',
    created_by: 'u-1',
    created_at: '2026-10-29T00:00:00Z',
    revoked_at: null,
    revoked_by: null,
    revoked_reason: null,
    ...overrides,
  }
}

/** A 1 250 kr card purchase at 25 %: 1 000 on 5410, 250 moms, 1 250 from the bank. */
const purchase25 = [
  { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
  { account_number: '2641', debit_amount: 250, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
]

const spotify: BookingReviewFacts = {
  accounts: ['5410', '2641', '1930'],
  bankRows: [{ counterpartyKey: 'spotify', amountSek: 1250 }],
  vatClasses: ['standard_25'],
}

describe('vatClassesFromLines', () => {
  it('reads the rate of ingående moms off its share of the gross', () => {
    expect(vatClassesFromLines(purchase25)).toEqual(['standard_25'])
    expect(
      vatClassesFromLines([
        { account_number: '5410', debit_amount: 892.86, credit_amount: 0 },
        { account_number: '2641', debit_amount: 107.14, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ]),
    ).toEqual(['reduced_12'])
    expect(
      vatClassesFromLines([
        { account_number: '5410', debit_amount: 943.4, credit_amount: 0 },
        { account_number: '2641', debit_amount: 56.6, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ]),
    ).toEqual(['reduced_6'])
  })

  it('gives an ingående moms share no rate gives every rate, so a block on a rate never misses it', () => {
    // A car lease with half its moms deductible: 125 of 1 250 is 10 %.
    expect(
      vatClassesFromLines([
        { account_number: '5615', debit_amount: 1125, credit_amount: 0 },
        { account_number: '2640', debit_amount: 125, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
      ]),
    ).toEqual(['reduced_12', 'reduced_6', 'standard_25'])
  })

  it('sums ingående moms in öre, so lines that net to zero carry none', () => {
    expect(
      vatClassesFromLines([
        { account_number: '2640', debit_amount: 0.1, credit_amount: 0 },
        { account_number: '2640', debit_amount: 0.2, credit_amount: 0 },
        { account_number: '2640', debit_amount: 0, credit_amount: 0.3 },
        { account_number: '5410', debit_amount: 100, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 100 },
      ]),
    ).toEqual(['none'])
  })

  it('reads a refund as its purchase', () => {
    expect(
      vatClassesFromLines([
        { account_number: '1930', debit_amount: 1250, credit_amount: 0 },
        { account_number: '5410', debit_amount: 0, credit_amount: 1000 },
        { account_number: '2641', debit_amount: 0, credit_amount: 250 },
      ]),
    ).toEqual(['standard_25'])
  })

  it('names reverse charge, utgående moms by rate, and no VAT', () => {
    expect(
      vatClassesFromLines([
        { account_number: '6540', debit_amount: 1000, credit_amount: 0 },
        { account_number: '2645', debit_amount: 250, credit_amount: 0 },
        { account_number: '2614', debit_amount: 0, credit_amount: 250 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ]),
    ).toEqual(['reverse_charge'])
    expect(
      vatClassesFromLines([
        { account_number: '1930', debit_amount: 1120, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
        { account_number: '2621', debit_amount: 0, credit_amount: 120 },
      ]),
    ).toEqual(['reduced_12'])
    expect(
      vatClassesFromLines([
        { account_number: '6570', debit_amount: 100, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 100 },
      ]),
    ).toEqual(['none'])
    expect(vatClassesFromLines([])).toEqual(['none'])
  })
})

describe('vatClassesOfTreatment', () => {
  it('maps a treatment to what its lines would carry, and an unknown one to null', () => {
    expect(vatClassesOfTreatment('standard_25')).toEqual(['standard_25'])
    expect(vatClassesOfTreatment('reverse_charge_domestic')).toEqual(['reverse_charge'])
    expect(vatClassesOfTreatment('export')).toEqual(['none'])
    expect(vatClassesOfTreatment('exempt')).toEqual(['none'])
    expect(vatClassesOfTreatment(null)).toBeNull()
    expect(vatClassesOfTreatment(undefined)).toBeNull()
  })
})

describe('grantCounterpartyKey', () => {
  it('keys a named counterparty and gives no key to bank wording or a payment rail', () => {
    expect(grantCounterpartyKey('Spotify AB', null, 'x')).toBe('spotify')
    expect(grantCounterpartyKey(null, null, 'PAYPAL')).toBe('')
    expect(grantCounterpartyKey('', 'INTERNET BET 4', 'x')).toBe('')
    expect(grantCounterpartyKey(null, null, 'PAYPAL *SPOTIFY')).toBe('spotify')
  })

  it('reads the merchant name, else the original description, else the description', () => {
    expect(grantCounterpartyKey(null, 'Telia Sverige AB', 'KORTKÖP 1234')).toBe(grantCounterpartyKey('Telia Sverige AB', null, null))
  })

  it('takes the row amount in kronor, without sign', () => {
    expect(bankRowFacts({ merchant_name: 'Spotify', amount: -10, amount_sek: -109.5 })).toEqual({ counterpartyKey: 'spotify', amountSek: 109.5 })
    expect(bankRowFacts({ merchant_name: 'Spotify', amount: -250, amount_sek: null }).amountSek).toBe(250)
  })
})

describe('ruleMatches', () => {
  it('matches when every criterion it sets matches', () => {
    expect(ruleMatches(rule({ accounts: ['5410'] }), spotify)).toBe(true)
    expect(ruleMatches(rule({ accounts: ['6250', '5410'] }), spotify)).toBe(true)
    expect(ruleMatches(rule({ accounts: ['6250'] }), spotify)).toBe(false)
    expect(ruleMatches(rule({ counterparty_key: 'spotify' }), spotify)).toBe(true)
    expect(ruleMatches(rule({ counterparty_key: 'telia' }), spotify)).toBe(false)
    expect(ruleMatches(rule({ amount_from_sek: 1250 }), spotify)).toBe(true)
    expect(ruleMatches(rule({ amount_from_sek: 1250.01 }), spotify)).toBe(false)
    expect(ruleMatches(rule({ vat_treatment: 'standard_25' }), spotify)).toBe(true)
    expect(ruleMatches(rule({ vat_treatment: 'reverse_charge' }), spotify)).toBe(false)
    expect(ruleMatches(rule({ accounts: ['5410'], vat_treatment: 'reverse_charge' }), spotify)).toBe(false)
  })

  it('judges the counterparty and the amount on one bank row together', () => {
    const two: BookingReviewFacts = {
      ...spotify,
      bankRows: [
        { counterpartyKey: 'spotify', amountSek: 100 },
        { counterpartyKey: 'telia', amountSek: 5000 },
      ],
    }
    expect(ruleMatches(rule({ counterparty_key: 'spotify', amount_from_sek: 1000 }), two)).toBe(false)
    expect(ruleMatches(rule({ counterparty_key: 'telia', amount_from_sek: 1000 }), two)).toBe(true)
  })

  it('counts an unknown VAT as meeting a VAT criterion, so the booking asks', () => {
    expect(ruleMatches(rule({ vat_treatment: 'reduced_6' }), { ...spotify, vatClasses: null })).toBe(true)
  })

  it('never matches an archived version', () => {
    expect(ruleMatches(rule({ accounts: ['5410'], revoked_at: '2026-10-29T01:00:00Z', revoked_reason: 'archived' }), spotify)).toBe(false)
  })

  it('names every matching rule with its version', () => {
    const rules = [rule({ id: 'a', rule_id: 'a', accounts: ['5410'] }), rule({ id: 'b2', rule_id: 'b', version: 2, counterparty_key: 'telia' })]
    expect(matchBookingReviewRules(rules, spotify)).toEqual([{ id: 'a', rule_id: 'a', version: 1 }])
  })

  it('judges a verifikat on its lines and the rows it books', () => {
    const facts = factsFromLines(purchase25, [bankRowFacts({ merchant_name: 'Spotify', amount: -1250 })])
    expect(facts.accounts).toEqual(['5410', '2641', '1930'])
    expect(ruleMatches(rule({ counterparty_key: 'spotify', vat_treatment: 'standard_25', amount_from_sek: 1000 }), facts)).toBe(true)
  })
})

describe('suggestions', () => {
  const tx = { merchant_name: 'Spotify AB', description: 'KORTKÖP SPOTIFY', amount: -119, amount_sek: null }
  const accountProposal: BookingProposal = {
    template_id: 'account:6540',
    source: 'assistant',
    booking: { kind: 'account', account: '6540', vat_treatment: 'standard_25', category: 'expense_software' },
    name_sv: 'IT-tjänster',
    name_en: 'IT services',
    group: 'account',
    debit_account: '6540',
    credit_account: '1930',
    confidence: 0.9,
    description_sv: '',
    risk_level: 'low',
    requires_review: false,
  }

  it('judges a suggestion on the accounts it names and the VAT its treatment books', () => {
    const facts = proposalFacts(accountProposal, tx)
    expect(facts.accounts).toEqual(['6540', '1930'])
    expect(facts.vatClasses).toEqual(['standard_25'])
    expect(facts.bankRows).toEqual([{ counterpartyKey: 'spotify', amountSek: 119 }])
  })

  it('reads a learned pattern’s VAT lines when the suggestion names no treatment', () => {
    const learned: BookingProposal = {
      ...accountProposal,
      template_id: 'cp:1',
      source: 'counterparty',
      booking: { kind: 'counterparty', counterparty_template_id: 'cp-1' },
      line_pattern: [
        { account: '6540', type: 'business', side: 'debit', ratio: 1 },
        { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
      ],
      vat_treatment: null,
    }
    expect(proposalFacts(learned, tx).vatClasses).toEqual(['standard_25'])
    expect(proposalFacts({ ...learned, line_pattern: null }, tx).vatClasses).toBeNull()
  })

  it('marks the suggestions a rule matches review_blocked, and leaves the rest', () => {
    const other = { ...accountProposal, template_id: 'account:5410', debit_account: '5410', booking: { ...accountProposal.booking, account: '5410' } as BookingProposal['booking'] }
    const marked = markBlockedProposals([accountProposal, other], tx, [rule({ accounts: ['6540'] })])
    expect(marked[0].review_blocked).toBe(true)
    expect(marked[1].review_blocked).toBeUndefined()
    expect(markBlockedProposals([accountProposal], tx, [])).toEqual([accountProposal])
  })
})
