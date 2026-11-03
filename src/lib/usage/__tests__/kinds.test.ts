import { describe, expect, it } from 'vitest'
import { BANK_PAYMENTS_INCLUDED_PER_MONTH } from '@/lib/payments/usage'
import { billedUsageKinds, formatOre, isPricedKind, usageLine, USAGE_GATED_KINDS, USAGE_KINDS, USAGE_PRICES } from '../kinds'

describe('usageLine', () => {
  it('includes as many bank payments as the payments cap does', () => {
    expect(USAGE_PRICES.bank_payment.includedPerMonth).toBe(BANK_PAYMENTS_INCLUDED_PER_MONTH)
  })

  it('bills the units above what the month includes, in whole öre', () => {
    expect(usageLine('bank_payment', 14)).toEqual({
      kind: 'bank_payment',
      used: 14,
      included: 10,
      billable: 4,
      unit_price_ore: 200,
      amount_ore: 800,
    })
  })

  it('bills nothing within the included amount', () => {
    expect(usageLine('peppol_send', 10)).toMatchObject({ billable: 0, amount_ore: 0 })
  })

  it('takes a company override of the included amount (a bank payments allowance with packs)', () => {
    expect(usageLine('bank_payment', 120, 110)).toMatchObject({ included: 110, billable: 10, amount_ore: 2000 })
  })

  it('bills every Kivra send: a month includes none', () => {
    expect(usageLine('kivra_send', 40)).toEqual({
      kind: 'kivra_send',
      used: 40,
      included: 0,
      billable: 40,
      unit_price_ore: 300,
      amount_ore: 12000,
    })
  })

  it('bills the signed documents above the three a month includes', () => {
    expect(usageLine('signing', 3)).toMatchObject({ included: 3, billable: 0, amount_ore: 0 })
    expect(usageLine('signing', 5)).toMatchObject({ included: 3, billable: 2, unit_price_ore: 1000, amount_ore: 2000 })
  })

  it('never bills an included kind', () => {
    expect(usageLine('billo_send', 40)).toMatchObject({ billable: 0, unit_price_ore: 0, amount_ore: 0 })
  })
})

describe('USAGE_GATED_KINDS', () => {
  it('stops every priced kind at the included amount until someone accepts: nothing is charged that nobody was asked about', () => {
    const priced = USAGE_KINDS.filter(isPricedKind)
    expect(priced.filter((kind) => !USAGE_GATED_KINDS.has(kind))).toEqual([])
  })
})

describe('billedUsageKinds', () => {
  it('bills nothing when unset or empty', () => {
    expect(billedUsageKinds({})).toEqual(new Set())
    expect(billedUsageKinds({ USAGE_BILLING_KINDS: '  ' })).toEqual(new Set())
  })

  it('takes listed kinds and ignores unknown and included ones', () => {
    expect(billedUsageKinds({ USAGE_BILLING_KINDS: 'peppol_send, kivra_send, nonsense,billo_send' })).toEqual(new Set(['peppol_send', 'kivra_send']))
  })

  it('takes every priced kind for *', () => {
    const all = billedUsageKinds({ USAGE_BILLING_KINDS: '*' })
    expect(all).toEqual(new Set(['bank_payment', 'peppol_send', 'kivra_send', 'signing', 'bank_account']))
    for (const kind of all) expect(isPricedKind(kind)).toBe(true)
  })
})

describe('formatOre', () => {
  it('writes kronor and öre with a comma', () => {
    expect(formatOre(200)).toBe('2,00 kr')
    expect(formatOre(1250)).toBe('12,50 kr')
    expect(formatOre(5)).toBe('0,05 kr')
  })
})
