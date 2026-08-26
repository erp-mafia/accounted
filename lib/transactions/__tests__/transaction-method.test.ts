import { describe, it, expect } from 'vitest'
import { classifyTransactionMethod } from '../transaction-method'
import { TRANSACTION_METHODS } from '@/types'

describe('classifyTransactionMethod', () => {
  // ── Trailing channel phrases (real Swedbank-style PSD2 strings) ──────────

  it('classifies and strips "Överföring via internet"', () => {
    const r = classifyTransactionMethod({ description: 'Vercel Jul Överföring via internet' })
    expect(r.method).toBe('transfer')
    expect(r.displayTitle).toBe('Vercel Jul')
  })

  it('classifies and strips "Kortköp/uttag"', () => {
    const r = classifyTransactionMethod({
      description: 'ANTHROPIC* CLAUDE SUB SAN FRANCISCO Kortköp/uttag',
    })
    expect(r.method).toBe('card')
    expect(r.displayTitle).toBe('ANTHROPIC* CLAUDE SUB SAN FRANCISCO')
  })

  it('classifies and strips "Bg-bet. via internet"', () => {
    const r = classifyTransactionMethod({
      description: 'Inbetalning skat BG 0000050501055 Bg-bet. via internet',
    })
    expect(r.method).toBe('bankgiro')
    expect(r.displayTitle).toBe('Inbetalning skat BG 0000050501055')
  })

  it('classifies and strips "Europabetalning" and its fee sibling "Pris betalning"', () => {
    const eu = classifyTransactionMethod({ description: '1260624917587 Europabetalning' })
    expect(eu.method).toBe('international')
    expect(eu.displayTitle).toBe('1260624917587')

    const fee = classifyTransactionMethod({ description: '1260624917587 Pris betalning' })
    expect(fee.method).toBe('fee')
    expect(fee.displayTitle).toBe('1260624917587')
  })

  it('classifies and strips "Insättning"', () => {
    const r = classifyTransactionMethod({ description: 'SWED2607270AUEOU Insättning' })
    expect(r.method).toBe('deposit')
    expect(r.displayTitle).toBe('SWED2607270AUEOU')
  })

  it('keeps a title that IS the phrase instead of emptying it', () => {
    const r = classifyTransactionMethod({ description: 'Insättning' })
    expect(r.method).toBe('deposit')
    expect(r.displayTitle).toBe('Insättning')
  })

  it('prefers the longer phrase over its substring', () => {
    // "överföring via internet" must win over the bare "överföring";
    // "kortköp/uttag" must win over "uttag" (which never matches: no
    // preceding whitespace).
    const r = classifyTransactionMethod({ description: 'Lön Juli Emil Överföring via internet' })
    expect(r.method).toBe('transfer')
    expect(r.displayTitle).toBe('Lön Juli Emil')
  })

  it('does not match a phrase inside a word', () => {
    // "Löneinsättning" ends in "insättning" but is salary, not deposit.
    const salary = classifyTransactionMethod({ description: 'ACME AB Löneinsättning' })
    expect(salary.method).toBe('salary')
    expect(salary.displayTitle).toBe('ACME AB')

    // "Bankavgift" (single word) is untouched by the bare "avgift" rule.
    const bankfee = classifyTransactionMethod({ description: 'Bankavgift' })
    expect(bankfee.method).toBeNull()
    expect(bankfee.displayTitle).toBe('Bankavgift')
  })

  it('classifies leading "Swish till/från" without stripping the counterparty', () => {
    const r = classifyTransactionMethod({ description: 'Swish till Erik Andersson' })
    expect(r.method).toBe('swish')
    expect(r.displayTitle).toBe('Swish till Erik Andersson')
  })

  it('adjective guard: classifies but never strips "Egen insättning" / "Eget uttag"', () => {
    // The phrase IS the meaning when preceded by a possessive/scope adjective:
    // stripping would leave a nonsense title ("Egen").
    const deposit = classifyTransactionMethod({ description: 'Egen insättning' })
    expect(deposit.method).toBe('deposit')
    expect(deposit.displayTitle).toBe('Egen insättning')

    const withdrawal = classifyTransactionMethod({ description: 'Eget uttag' })
    expect(withdrawal.method).toBe('withdrawal')
    expect(withdrawal.displayTitle).toBe('Eget uttag')

    const transfer = classifyTransactionMethod({ description: 'Intern överföring' })
    expect(transfer.method).toBe('transfer')
    expect(transfer.displayTitle).toBe('Intern överföring')
  })

  // ── ISO 20022 / proprietary codes ────────────────────────────────────────

  it('classifies from the ISO 20022 family when no phrase matches', () => {
    const r = classifyTransactionMethod({
      description: 'COOP KONSUM STOCKHOLM',
      bankTransactionCode: 'PMNT-CCRD-POSD',
    })
    expect(r.method).toBe('card')
    expect(r.displayTitle).toBe('COOP KONSUM STOCKHOLM')
  })

  it('lets the ISO subfamily refine the family default', () => {
    expect(
      classifyTransactionMethod({
        description: 'Payroll run',
        bankTransactionCode: 'PMNT/ICDT/SALA',
      }).method
    ).toBe('salary')
    expect(
      classifyTransactionMethod({
        description: 'Payment abroad',
        bankTransactionCode: 'PMNT/ICDT/XBCT',
      }).method
    ).toBe('international')
  })

  it('lets a subfamily on the second code beat a family match on the first', () => {
    // The ISO code carries only DOMAIN/FAMILY while the proprietary code
    // carries the full triple: the SALA refinement must still win.
    const r = classifyTransactionMethod({
      description: 'Payroll run',
      bankTransactionCode: 'PMNT/ICDT',
      proprietaryBankTransactionCode: 'PMNT-ICDT-SALA',
    })
    expect(r.method).toBe('salary')
  })

  it('prefers the bank-authored phrase over the generic ISO family', () => {
    // A Bankgiro payment travels as an issued credit transfer (ICDT): the
    // phrase is the more specific truth.
    const r = classifyTransactionMethod({
      description: 'TELIA AB Bg-betalning',
      bankTransactionCode: 'PMNT/ICDT',
    })
    expect(r.method).toBe('bankgiro')
    expect(r.displayTitle).toBe('TELIA AB')
  })

  it('falls back to a keyword scan over proprietary codes', () => {
    const r = classifyTransactionMethod({
      description: 'Some row',
      proprietaryBankTransactionCode: 'SWISH_PAYMENT',
    })
    expect(r.method).toBe('swish')
  })

  // ── MCC and explicit methods ─────────────────────────────────────────────

  it('uses MCC presence as the card-rail fallback (6011 = ATM withdrawal)', () => {
    expect(
      classifyTransactionMethod({ description: 'SPOTIFY AB', mccCode: 5815 }).method
    ).toBe('card')
    expect(
      classifyTransactionMethod({ description: 'BANKOMAT 123', mccCode: 6011 }).method
    ).toBe('withdrawal')
  })

  it('lets an explicit source method beat every heuristic', () => {
    const r = classifyTransactionMethod({
      description: 'Stripe-utbetalning po_123 Kortköp',
      explicitMethod: 'transfer',
    })
    expect(r.method).toBe('transfer')
    // The phrase strip still applies to the title.
    expect(r.displayTitle).toBe('Stripe-utbetalning po_123')
  })

  it('returns null method and the untouched title when nothing matches', () => {
    const r = classifyTransactionMethod({ description: 'Okänd transaktion' })
    expect(r.method).toBeNull()
    expect(r.displayTitle).toBe('Okänd transaktion')
  })

  it('every classified method is part of the closed vocabulary', () => {
    const samples = [
      'X Överföring via internet',
      'X Kortköp',
      'X Bg-betalning',
      'X Plusgiro',
      'X Swish',
      'X Autogiro',
      'X E-faktura',
      'X Europabetalning',
      'X Insättning',
      'X Uttag',
      'X Lönebetalning',
      'X Avgift',
      'X Ränta',
    ]
    for (const description of samples) {
      const { method } = classifyTransactionMethod({ description })
      expect(method).not.toBeNull()
      expect(TRANSACTION_METHODS).toContain(method)
    }
  })

  it('stripping yields a prefix of the original (dedup-bridge invariant)', () => {
    const cases = [
      'Vercel Jul Överföring via internet',
      'TIC  BG 0000005786439 Bg-bet. via internet',
      'UTBETALNING Insättning',
      'ANTHROPIC* CLAUDE SUB SAN FRANCISCO Kortköp/uttag',
    ]
    for (const description of cases) {
      const { displayTitle } = classifyTransactionMethod({ description })
      expect(description.toLowerCase().startsWith(displayTitle.toLowerCase())).toBe(true)
    }
  })
})
