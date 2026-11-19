import { describe, expect, it } from 'vitest'
import { PURCHASE_CATEGORY_CODES } from '@/lib/categories/purchase-categories'
import { PURCHASE_CATEGORY_VAT_NATURE, purchaseVatNature } from '../purchase-category-vat-nature'

describe('PURCHASE_CATEGORY_VAT_NATURE', () => {
  it('names every purchase category, and nothing else', () => {
    expect(Object.keys(PURCHASE_CATEGORY_VAT_NATURE).sort()).toEqual([...PURCHASE_CATEGORY_CODES].sort())
  })

  it('reads software, advertising and professional services as services', () => {
    expect(purchaseVatNature('expense.software.saas')).toBe('service')
    expect(purchaseVatNature('expense.marketing.ads')).toBe('service')
    expect(purchaseVatNature('expense.professional_services.legal')).toBe('service')
  })

  it('keeps the place-of-supply exceptions and the exempt out of reverse charge', () => {
    for (const code of [
      'expense.travel.hotel',
      'expense.travel.flight',
      'expense.travel.car_rental',
      'expense.travel.meals',
      'expense.marketing.events',
      'expense.premises.rent',
      'expense.insurance.business',
      'expense.bank_fees.fees',
    ] as const) {
      expect(purchaseVatNature(code)).toBe('exception')
    }
  })

  it('reads hardware and materials as goods', () => {
    expect(purchaseVatNature('expense.equipment.hardware')).toBe('goods')
    expect(purchaseVatNature('expense.goods.materials')).toBe('goods')
  })
})
