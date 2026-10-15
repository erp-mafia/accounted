import { describe, it, expect } from 'vitest'
import {
  bestInvoiceMatch,
  calculateMatchScore,
  customerPhoneMatches,
  matchInvoiceCandidates,
  normalizeSwedishMobile,
  swedishMobileNumbersIn,
  type MatchableInvoice,
} from '../invoice-matching'
import type { Transaction } from '@/types'
import { makeCustomer, makeInvoice, makeTransaction } from '@/tests/helpers'

// Fictional numbers only: PTS reserves 070-174 06 05 to 070-174 06 99 for
// fiction. The Swish ids below are made up.
const PAYER = '+46701740605'
const OTHER = '+46701740650'
const SWISH_ID = '1234567890123456'

/** The dominant Enable Banking Swish shape: phone, Swish id, "Swish", phone. */
function swishRow(phone: string, overrides: Partial<Transaction> = {}): Transaction {
  return makeTransaction({
    amount: 500,
    description: `${phone}    ${SWISH_ID} Swish ${phone}`,
    merchant_name: null,
    reference: null,
    ...overrides,
  })
}

function openInvoice(id: string, invoiceNumber: string, name: string, phone: string | null): MatchableInvoice {
  return {
    ...makeInvoice({
      id,
      invoice_number: invoiceNumber,
      total: 500,
      remaining_amount: 500,
      status: 'sent',
      currency: 'SEK',
    }),
    customer: makeCustomer({ name, phone }),
  }
}

describe('swedishMobileNumbersIn', () => {
  it.each([
    ['+46701740605'],
    ['+46 70 174 06 05'],
    ['+46 70-174 06 05'],
    ['0046701740605'],
    ['0046 70 174 06 05'],
    ['0701740605'],
    ['070-174 06 05'],
    ['070-1740605'],
  ])('reads %s as the same number', (written) => {
    expect(swedishMobileNumbersIn(`Swish från ${written} tack`)).toEqual([PAYER])
  })

  it('reads both phones in the Enable Banking shape and nothing from the Swish id', () => {
    expect(swedishMobileNumbersIn(`${PAYER}    ${SWISH_ID} Swish ${PAYER}`)).toEqual([PAYER, PAYER])
  })

  it.each([
    ['a Swish id holding the digits', 'Swish 9070174060512345'],
    ['a Swish id starting with the digits', 'Swish 0701740605123456'],
    ['a Swish id starting with 0046 and the digits', '0046701740605123'],
    ['a longer digit run', '120701740605'],
    ['too few digits', '070 174 06 0'],
    ['a landline', '08-123 456 78'],
  ])('never reads %s as a number', (_label, text) => {
    expect(swedishMobileNumbersIn(text)).toEqual([])
  })

  it('returns nothing for an empty text', () => {
    expect(swedishMobileNumbersIn(null)).toEqual([])
    expect(swedishMobileNumbersIn('')).toEqual([])
  })
})

describe('normalizeSwedishMobile', () => {
  it.each([
    ['070-174 06 05'],
    ['0701740605'],
    ['+46 70 174 06 05'],
    ['+46 (0)70 174 06 05'],
    ['0046 70 174 06 05'],
  ])('normalises %s', (stored) => {
    expect(normalizeSwedishMobile(stored)).toBe(PAYER)
  })

  it('returns null for a landline, a blank or a missing phone', () => {
    expect(normalizeSwedishMobile('08-123 456 78')).toBeNull()
    expect(normalizeSwedishMobile('')).toBeNull()
    expect(normalizeSwedishMobile(null)).toBeNull()
  })
})

describe('customerPhoneMatches', () => {
  it('finds the phone in description, merchant name or reference', () => {
    const blank = { description: 'Inbetalning', merchant_name: null, reference: null }
    expect(customerPhoneMatches('070-174 06 05', { ...blank, description: `Swish ${PAYER}` })).toBe(true)
    expect(customerPhoneMatches('070-174 06 05', { ...blank, merchant_name: '0701740605' })).toBe(true)
    expect(customerPhoneMatches('070-174 06 05', { ...blank, reference: '+46 70 174 06 05' })).toBe(true)
  })

  it('does not match another number or a Swish id holding the digits', () => {
    expect(customerPhoneMatches('070-174 06 05', { description: `Swish ${OTHER}`, merchant_name: null, reference: null })).toBe(false)
    expect(customerPhoneMatches('070-174 06 05', { description: 'Swish 9070174060512345', merchant_name: null, reference: null })).toBe(false)
  })
})

describe('calculateMatchScore with a Swish phone', () => {
  it('lifts an exact amount to the customer tier when the phone matches', () => {
    const { confidence, matchReason } = calculateMatchScore(swishRow(PAYER), openInvoice('a', 'F-2026101', 'Anna Exempel', '070-174 06 05'))
    expect(confidence).toBe(0.95)
    expect(matchReason).toBe('Exakt belopp (500 SEK) och kundens telefonnummer matchar')
  })

  it('lifts a fuzzy amount to the customer tier when the phone matches', () => {
    const { confidence, matchReason } = calculateMatchScore(swishRow(PAYER, { amount: 496 }), openInvoice('a', 'F-2026101', 'Anna Exempel', '070-174 06 05'))
    expect(confidence).toBe(0.70)
    expect(matchReason).toBe('Belopp nära (±1%) och kundens telefonnummer matchar')
  })

  it('keeps the name reason when both name and phone match', () => {
    const { confidence, matchReason } = calculateMatchScore(
      swishRow(PAYER, { description: `${PAYER} ${SWISH_ID} Swish Anna Exempel` }),
      openInvoice('a', 'F-2026101', 'Anna Exempel', '070-174 06 05'),
    )
    expect(confidence).toBe(0.95)
    expect(matchReason).toContain('kundnamn matchar')
  })

  it('never matches on the phone alone', () => {
    const { confidence } = calculateMatchScore(swishRow(PAYER, { amount: 900 }), openInvoice('a', 'F-2026101', 'Anna Exempel', '070-174 06 05'))
    expect(confidence).toBe(0)
  })

  it('scores as today when the customer has no phone', () => {
    const { confidence, matchReason } = calculateMatchScore(swishRow(PAYER), openInvoice('a', 'F-2026101', 'Anna Exempel', null))
    expect(confidence).toBe(0.80)
    expect(matchReason).toBe('Exakt belopp (500 SEK)')
  })

  it('scores as today when the row carries no phone', () => {
    const { confidence, matchReason } = calculateMatchScore(
      swishRow(PAYER, { description: `Swish ${SWISH_ID}` }),
      openInvoice('a', 'F-2026101', 'Anna Exempel', '070-174 06 05'),
    )
    expect(confidence).toBe(0.80)
    expect(matchReason).toBe('Exakt belopp (500 SEK)')
  })
})

describe('matching a Swish payment among same-amount invoices', () => {
  it("picks the payer's invoice over another customer's invoice listed first", () => {
    const pool = {
      invoices: [
        openInvoice('inv-other', 'F-2026101', 'Bertil Prov', '070-174 06 50'),
        openInvoice('inv-payer', 'F-2026102', 'Anna Exempel', '070-174 06 05'),
      ],
    }

    const best = bestInvoiceMatch(swishRow(PAYER), pool)

    expect(best?.invoice.id).toBe('inv-payer')
    expect(best?.confidence).toBe(0.95)
    const { matches } = matchInvoiceCandidates(swishRow(PAYER), pool)
    expect(matches.map((m) => [m.invoice.id, m.confidence])).toEqual([
      ['inv-payer', 0.95],
      ['inv-other', 0.80],
    ])
  })

  it('leaves the order unchanged when no customer has a phone', () => {
    const pool = {
      invoices: [
        openInvoice('inv-first', 'F-2026101', 'Bertil Prov', null),
        openInvoice('inv-second', 'F-2026102', 'Anna Exempel', null),
      ],
    }

    const { matches } = matchInvoiceCandidates(swishRow(PAYER), pool)

    expect(matches.map((m) => [m.invoice.id, m.confidence])).toEqual([
      ['inv-first', 0.80],
      ['inv-second', 0.80],
    ])
  })

  it('offers nothing when the phone matches but the amount does not', () => {
    const pool = { invoices: [openInvoice('inv-payer', 'F-2026102', 'Anna Exempel', '070-174 06 05')] }

    expect(matchInvoiceCandidates(swishRow(PAYER, { amount: 900 }), pool).matches).toEqual([])
    expect(bestInvoiceMatch(swishRow(PAYER, { amount: 900 }), pool)).toBeNull()
  })
})
