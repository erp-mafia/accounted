/**
 * A sale's treatment, legal form and goods-or-services nature pick one revenue
 * account, so it lands in the right ruta whichever door booked it: a category
 * booking of a bank row asks getRevenueAccount as an invoice does. Goods
 * belong in ruta 35 and 36, services in 39 and 40 (swedish-vat §7).
 */
import { describe, it, expect } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import { buildMappingResultFromCategory } from '../category-mapping'
import { getRevenueAccount } from '../invoice-accounts'
import { getBoxForAccount } from '@/lib/vat/moms-box-mapping'
import type { EntityType, VatTreatment } from '@/types'

const creditOn = (category: 'income_services' | 'income_products', treatment: VatTreatment, form: EntityType = 'aktiebolag') =>
  buildMappingResultFromCategory(category, makeTransaction({ amount: 1250 }), true, form, treatment).credit_account

describe('the revenue account of a category sale', () => {
  it.each([
    ['export', '3105', '36'],
    ['reverse_charge', '3108', '35'],
  ] as const)('goods at %s book the goods account, ruta %s', (treatment, account, ruta) => {
    expect(creditOn('income_products', treatment)).toBe(account)
    expect(getBoxForAccount(account)).toBe(ruta)
  })

  it.each([
    ['export', '3305', '40'],
    ['reverse_charge', '3308', '39'],
  ] as const)('services at %s book the services account, ruta %s', (treatment, account, ruta) => {
    expect(creditOn('income_services', treatment)).toBe(account)
    expect(getBoxForAccount(account)).toBe(ruta)
  })

  it.each(['aktiebolag', 'ekonomisk_forening', 'enskild_firma', 'ideell_forening'] as EntityType[])(
    'every treatment on %s books the account an invoice books',
    (form) => {
      for (const treatment of ['standard_25', 'reduced_12', 'reduced_6', 'exempt', 'export', 'reverse_charge'] as VatTreatment[]) {
        expect(creditOn('income_services', treatment, form)).toBe(getRevenueAccount(treatment, form))
        expect(creditOn('income_products', treatment, form)).toBe(getRevenueAccount(treatment, form, { goods: true }))
      }
    },
  )

  it('a momsfri sale books the legal form\'s own account', () => {
    expect(creditOn('income_services', 'exempt', 'aktiebolag')).toBe('3004')
    expect(creditOn('income_services', 'exempt', 'enskild_firma')).toBe('3100')
  })

  it('no stated treatment books the default rate\'s account', () => {
    const tx = makeTransaction({ amount: 1250 })
    expect(buildMappingResultFromCategory('income_products', tx, true, 'aktiebolag').credit_account).toBe('3001')
  })

  it('income_other stays on 3999: other operating income is not nettoomsättning', () => {
    const tx = makeTransaction({ amount: 1250 })
    expect(buildMappingResultFromCategory('income_other', tx, true, 'aktiebolag', 'exempt').credit_account).toBe('3999')
    expect(buildMappingResultFromCategory('income_other', tx, true, 'aktiebolag', 'standard_25').credit_account).toBe('3999')
  })
})
