/**
 * The skeleton the manual-booking dialog opens with when the engine has no
 * proposal. Two things matter: the kronor figure comes from the bank row (via
 * the honest SEK ladder, never the raw foreign amount), and the two rows
 * always balance, so the form's balance check starts green.
 */
import { describe, it, expect } from 'vitest'
import { buildFallbackKonteringLines } from '@/extensions/general/invoice-inbox/lib/fallback-kontering'

describe('buildFallbackKonteringLines', () => {
  it('seeds a purchase as blank-cost debit against a settlement credit', () => {
    const lines = buildFallbackKonteringLines(
      { amount: -216.39, amount_sek: null, currency: 'SEK', exchange_rate: null },
      '1930',
    )
    expect(lines).toEqual([
      { account_number: '', debit_amount: 216.39, credit_amount: 0, description: '' },
      { account_number: '1930', debit_amount: 0, credit_amount: 216.39, description: '' },
    ])
  })

  it('reverses the legs when money came in', () => {
    const lines = buildFallbackKonteringLines(
      { amount: 500, amount_sek: null, currency: 'SEK', exchange_rate: null },
      '1930',
    )
    expect(lines).toEqual([
      { account_number: '1930', debit_amount: 500, credit_amount: 0, description: '' },
      { account_number: '', debit_amount: 0, credit_amount: 500, description: '' },
    ])
  })

  it('uses the stored SEK amount for a foreign row, not the foreign figure', () => {
    // The user-reported case: a EUR invoice whose only kronor figure is the
    // bank movement. 6.25 EUR must not be prefilled as 6,25 kr.
    const lines = buildFallbackKonteringLines(
      { amount: -6.25, amount_sek: -71.83, currency: 'EUR', exchange_rate: 11.4928 },
      '1930',
    )
    expect(lines[0].debit_amount).toBe(71.83)
    expect(lines[1].credit_amount).toBe(71.83)
  })

  it('returns nothing for a foreign row with no SEK value and no rate', () => {
    // Relabeling 100 EUR as 100 kr is worse than an empty form.
    expect(
      buildFallbackKonteringLines(
        { amount: -100, amount_sek: null, currency: 'EUR', exchange_rate: null },
        '1930',
      ),
    ).toEqual([])
  })

  it('returns nothing for a zero amount', () => {
    expect(
      buildFallbackKonteringLines(
        { amount: 0, amount_sek: null, currency: 'SEK', exchange_rate: null },
        '1930',
      ),
    ).toEqual([])
  })

  it('rounds to whole öre and stays balanced', () => {
    const lines = buildFallbackKonteringLines(
      { amount: -10, amount_sek: null, currency: 'USD', exchange_rate: 9.4567 },
      '1932',
    )
    const debit = lines.reduce((t, l) => t + l.debit_amount, 0)
    const credit = lines.reduce((t, l) => t + l.credit_amount, 0)
    expect(debit).toBe(94.57)
    expect(Math.round((debit - credit) * 100)).toBe(0)
    expect(lines[1].account_number).toBe('1932')
  })
})
