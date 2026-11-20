import { describe, expect, it } from 'vitest'
import { resolveAccountCurrency } from '../account-currency'

// Feedback seq 753539: accounts the bank reports as 'XXX' (ISO 4217 "no
// currency") were stored verbatim and never matched a transaction currency.
describe('resolveAccountCurrency', () => {
  it.each([
    ['SEK', 'SEK'],
    ['eur', 'EUR'],
    [' usd ', 'USD'],
  ])('keeps a reported currency %j as %s, over any evidence', (reported, expected) => {
    expect(resolveAccountCurrency(reported, ['NOK'])).toBe(expected)
  })

  it.each(['XXX', 'xxx', '', '   ', null, undefined, 'SEKK', 'S1K'])(
    'reads %j as unknown and falls back to SEK without evidence',
    (reported) => {
      expect(resolveAccountCurrency(reported)).toBe('SEK')
    },
  )

  it('takes the first known currency from the evidence, strongest first', () => {
    // Stored currency, then a balance's balance_amount.currency, then a transaction's.
    expect(resolveAccountCurrency('XXX', ['EUR', 'USD', 'SEK'])).toBe('EUR')
    expect(resolveAccountCurrency('XXX', [undefined, 'usd', 'SEK'])).toBe('USD')
    expect(resolveAccountCurrency(undefined, [null, '', 'GBP'])).toBe('GBP')
  })

  it('never returns XXX, even when every piece of evidence is XXX', () => {
    expect(resolveAccountCurrency('XXX', ['XXX', 'xxx', null])).toBe('SEK')
  })
})
