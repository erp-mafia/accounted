/**
 * The box of a reverse-charge purchase booked in bulk (#58 "Bulk doors carry
 * no box"): ruta 21 for an EU service, 22 for a service from outside the EU,
 * 20 for EU goods (swedish-vat skill 2.1-2.3, SKV 4700 rutor 20-22), and no
 * box at all (left out) when the seller or the kind of purchase is unclear.
 * The account and ruta assertions run the real basis-pair builder and the
 * declaration's account map, so the box is pinned end to end.
 */
import { describe, it, expect } from 'vitest'
import { purchaseSellerRegion, reverseChargeBoxFor } from '../reverse-charge-box'
import { generateReverseChargePurchaseLines, reverseChargeKindRuta, type ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import { ACCOUNT_TO_BOX } from '../moms-box-mapping'

function basisAccount(kind: ReverseChargeKind): string | undefined {
  return generateReverseChargePurchaseLines({ base: 1000, kind }).find((l) => /^45[13]/.test(l.account_number))?.account_number
}

const EU_SELLER = { vatNumber: 'DE123456789', address: 'Musterstrasse 1, 10115 Berlin, Germany' }
const US_SELLER = { vatNumber: null, address: '1 Example Ave, Austin, TX 78701' }
const SWEDISH_SELLER = { orgNumber: '556677-8899', address: 'Storgatan 1, 111 22 Stockholm' }

describe('reverseChargeBoxFor', () => {
  it('books a service from an EU seller in ruta 21 on 4535', () => {
    const box = reverseChargeBoxFor(purchaseSellerRegion(EU_SELLER), 'expense_software')
    expect(box).toEqual({ ok: true, kind: 'eu_services' })
    if (!box.ok) return
    expect(reverseChargeKindRuta(box.kind)).toBe('ruta21')
    expect(basisAccount(box.kind)).toBe('4535')
    expect(ACCOUNT_TO_BOX['4535']).toBe('21')
  })

  it('books a service from a US seller in ruta 22 on 4531', () => {
    const box = reverseChargeBoxFor(purchaseSellerRegion(US_SELLER), 'expense_software')
    expect(box).toEqual({ ok: true, kind: 'non_eu_services' })
    if (!box.ok) return
    expect(reverseChargeKindRuta(box.kind)).toBe('ruta22')
    expect(basisAccount(box.kind)).toBe('4531')
    expect(ACCOUNT_TO_BOX['4531']).toBe('22')
  })

  it('books goods from an EU seller in ruta 20 on 4515', () => {
    const box = reverseChargeBoxFor(purchaseSellerRegion(EU_SELLER), 'expense_equipment')
    expect(box).toEqual({ ok: true, kind: 'eu_goods' })
    if (!box.ok) return
    expect(reverseChargeKindRuta(box.kind)).toBe('ruta20')
    expect(basisAccount(box.kind)).toBe('4515')
    expect(ACCOUNT_TO_BOX['4515']).toBe('20')
  })

  it('leaves out a purchase whose seller country cannot be read, never ruta 21 by default', () => {
    const box = reverseChargeBoxFor(purchaseSellerRegion({ vatNumber: null, address: null }), 'expense_software')
    expect(box).toMatchObject({ ok: false, reason: 'seller_country_unknown' })
    if (box.ok) return
    expect(box.messageSv).toMatch(/land går inte att läsa/)
  })

  it('leaves out goods from outside the EU: import moms (ruta 50/60), not reverse charge', () => {
    expect(reverseChargeBoxFor('non_eu', 'expense_consumables')).toMatchObject({ ok: false, reason: 'goods_from_outside_eu' })
  })

  it('leaves out a Swedish seller: domestic reverse charge (ruta 23/24) is booked one at a time', () => {
    expect(reverseChargeBoxFor(purchaseSellerRegion(SWEDISH_SELLER), 'expense_professional_services')).toMatchObject({
      ok: false,
      reason: 'seller_in_sweden',
    })
  })

  it('leaves out a category that does not say goods or service', () => {
    for (const category of ['expense_other', 'expense_office', 'expense_travel', 'expense_representation', 'expense_bank_fees'] as const) {
      expect(reverseChargeBoxFor('eu', category)).toMatchObject({ ok: false, reason: 'purchase_kind_unknown' })
    }
  })
})

describe('purchaseSellerRegion', () => {
  it('reads the document first', () => {
    expect(purchaseSellerRegion(EU_SELLER, 'non_eu_business')).toBe('eu')
  })

  it('falls back to a supplier card that says abroad', () => {
    expect(purchaseSellerRegion({ vatNumber: null }, 'non_eu_business')).toBe('non_eu')
    expect(purchaseSellerRegion(null, 'eu_business')).toBe('eu')
  })

  it("does not take a card's default swedish_business as evidence", () => {
    expect(purchaseSellerRegion({ vatNumber: null }, 'swedish_business')).toBeNull()
    expect(purchaseSellerRegion(null, null)).toBeNull()
  })
})
