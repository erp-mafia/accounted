/**
 * The box of a reverse-charge purchase booked in bulk (#58 "Bulk doors carry
 * no box"): ruta 21 for an EU service, 22 for a service from outside the EU,
 * 20 for EU goods (swedish-vat skill 2.1-2.3, SKV 4700 rutor 20-22), and no
 * box at all (left out) when the seller or the kind of purchase is unclear.
 * The account and ruta assertions run the real basis-pair builder and the
 * declaration's account map, so the box is pinned end to end.
 */
import { describe, it, expect } from 'vitest'
import {
  FOREIGN_SELLER_VAT_FLAG,
  purchaseSellerRegion,
  reverseChargeBoxAsk,
  reverseChargeBoxFor,
  sellerChargedVat,
  sellerVatOnReverseCharge,
  sellerVatRefusalMessage,
} from '../reverse-charge-box'
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

// #94: the single agent/API door asks for the box in its own parameter.
describe('reverseChargeBoxAsk', () => {
  it('names the reason and the values of the door\'s parameter, in both languages', () => {
    const v1 = reverseChargeBoxAsk('seller_country_unknown', 'reverse_charge_kind')
    expect(v1.sv).toMatch(/säljarens land/)
    expect(v1.sv).toMatch(/reverse_charge_kind "eu_services" .*ruta 21.*"non_eu_services" .*ruta 22.*"eu_goods" .*ruta 20/)
    expect(v1.en).toMatch(/seller's country/)
    const mcp = reverseChargeBoxAsk('purchase_kind_unknown', 'vat_treatment')
    expect(mcp.sv).toMatch(/vat_treatment "reverse_charge_eu_services" \(ruta 21\)/)
    expect(mcp.sv).not.toMatch(/reverse_charge_kind/)
  })
})

// #94: the seller's charge, as the reading states it (breakdown first).
describe('sellerChargedVat', () => {
  it('sums the charged breakdown groups, else takes the total VAT, else 0', () => {
    expect(sellerChargedVat({ vatBreakdown: [{ amount: 10 }, { amount: 2.5 }, { amount: 0 }], totals: { vatAmount: 99 } })).toBe(12.5)
    expect(sellerChargedVat({ vatBreakdown: [], totals: { vatAmount: 25 } })).toBe(25)
    expect(sellerChargedVat({ totals: { vatAmount: 0 } })).toBe(0)
    expect(sellerChargedVat({ totals: { vatAmount: -5 } })).toBe(0)
    expect(sellerChargedVat(null)).toBe(0)
  })
})

// crm#1765: the seller charged VAT on a purchase the buyer is liable for.
describe('sellerVatOnReverseCharge', () => {
  it('is a plain reverse charge when the underlag shows no charge', () => {
    expect(sellerVatOnReverseCharge({ sellerVat: 0, confirmedForeign: false })).toEqual({ verdict: 'no_seller_vat' })
    expect(sellerVatOnReverseCharge({ sellerVat: null, confirmedForeign: true })).toEqual({ verdict: 'no_seller_vat' })
  })

  it('refuses a charge nobody has stated to be foreign', () => {
    expect(sellerVatOnReverseCharge({ sellerVat: 21, total: 121, confirmedForeign: false })).toEqual({
      verdict: 'refused',
      reason: 'not_confirmed',
      addressCountry: null,
    })
  })

  it('allows a charge stated to be foreign, and tells a rate that is not the Swedish one', () => {
    expect(sellerVatOnReverseCharge({ sellerVat: 21, total: 121, seller: { vatNumber: 'NL123456789B01' }, confirmedForeign: true })).toEqual({
      verdict: 'confirmed',
      couldBeSwedishVat: false,
    })
  })

  it('cannot rule Swedish VAT out at 25 % of the price, or without a total to measure against', () => {
    expect(sellerVatOnReverseCharge({ sellerVat: 25, total: 125, confirmedForeign: true })).toEqual({ verdict: 'confirmed', couldBeSwedishVat: true })
    expect(sellerVatOnReverseCharge({ sellerVat: 25, total: null, confirmedForeign: true })).toEqual({ verdict: 'confirmed', couldBeSwedishVat: true })
  })

  it('refuses a seller the document names as Swedish, stated foreign or not', () => {
    for (const confirmedForeign of [true, false]) {
      expect(sellerVatOnReverseCharge({ sellerVat: 25, total: 125, seller: { vatNumber: 'SE556677889901' }, confirmedForeign })).toEqual({
        verdict: 'refused',
        reason: 'seller_vat_swedish',
        source: 'vat_number',
      })
    }
  })

  // A Swedish VAT number beside an address abroad: the seller may not be
  // established here for the sale (ML 2023:200 16 kap. 4 §), and then the
  // buyer owes the VAT (16 kap. 9 §) and the charge is felaktigt debiterad
  // (2 kap. 12 §), never ingående moms (13 kap. 4 §). The person says which.
  const ABROAD = { vatNumber: 'SE502012345601', address: '1 Main St, Austin, Texas 78701, United States' }

  it('asks about a Swedish VAT number beside an address abroad, naming the country, instead of refusing it as Swedish', () => {
    expect(sellerVatOnReverseCharge({ sellerVat: 25, total: 125, seller: ABROAD, confirmedForeign: false })).toEqual({
      verdict: 'refused',
      reason: 'not_confirmed',
      addressCountry: 'US',
    })
  })

  it('books it on the person\'s word, without the warning to check it is not Swedish VAT', () => {
    expect(sellerVatOnReverseCharge({ sellerVat: 25, total: 125, seller: ABROAD, confirmedForeign: true })).toEqual({
      verdict: 'confirmed',
      couldBeSwedishVat: false,
    })
  })

  it('words the question for a Swedish VAT number abroad: the flag, the country, and when the rate applies instead', () => {
    const ask = sellerVatRefusalMessage('not_confirmed', '13.06 USD', 'SG')
    expect(ask.sv).toContain(`${FOREIGN_SELLER_VAT_FLAG}=true`)
    expect(ask.en).toContain(`${FOREIGN_SELLER_VAT_FLAG}=true`)
    expect(ask.sv).toContain('Singapore')
    expect(ask.en).toContain('Singapore')
    expect(ask.sv).toContain('13.06 USD')
    expect(ask.sv).toMatch(/inte etablerad i Sverige/)
    expect(ask.en).toMatch(/not established in Sweden/)
    expect(ask.sv).not.toMatch(/utländsk moms/)
  })

  it('leaves the box unread for a Swedish VAT number abroad unless the supplier card says abroad', () => {
    expect(purchaseSellerRegion(ABROAD)).toBeNull()
    expect(purchaseSellerRegion(ABROAD, 'non_eu_business')).toBe('non_eu')
  })

  // Ruta 20 is goods sent here from another EU country (ML 2023:200 5 kap. 22 §); the invoice shows the
  // number the goods were supplied under (17 kap. 24 § p. 3). An SE number may be a purchase in Sweden, where
  // the seller owes the VAT (16 kap. 5 §) and only certain goods are the buyer's, in ruta 23 (16 kap. 6 §).
  it('boxes no goods sold under a Swedish VAT number abroad, whatever region a card or a statement gives', () => {
    const LUXEMBOURG = { vatNumber: 'SE502012345601', address: '38 Example Avenue, L-1855 Luxembourg' }
    for (const category of ['expense_equipment', 'expense_consumables'] as const) {
      for (const region of ['eu', 'non_eu', null] as const) {
        const box = reverseChargeBoxFor(region, category, [{}, LUXEMBOURG])
        expect(box).toMatchObject({ ok: false, reason: 'goods_under_swedish_vat_number' })
        if (!box.ok) expect(box.messageSv).toMatch(/ruta 20\).*säljaren normalt tar ut svensk moms.*ruta 23 gäller bara vissa varor/)
      }
    }
    // A service from the same seller keeps its region (#3814), and goods from another state's number box in ruta 20.
    expect(reverseChargeBoxFor('eu', 'expense_software', [LUXEMBOURG])).toEqual({ ok: true, kind: 'eu_services' })
    expect(reverseChargeBoxFor('eu', 'expense_equipment', [EU_SELLER, null])).toEqual({ ok: true, kind: 'eu_goods' })
    expect(reverseChargeBoxFor(purchaseSellerRegion(null, 'eu_business'), 'expense_equipment', [null])).toEqual({ ok: true, kind: 'eu_goods' })
  })

  it('asks for the box of such goods, naming ruta 23 only for certain goods, in both locales', () => {
    const ask = reverseChargeBoxAsk('goods_under_swedish_vat_number', 'reverse_charge_kind')
    expect(ask.sv).toMatch(/svenskt momsnummer med adress utomlands.*normalt tar ut svensk moms.*ruta 23 gäller bara vissa varor/)
    expect(ask.en).toMatch(/Swedish VAT number beside an address abroad.*normally charges Swedish VAT.*box 23 covers only certain goods/)
  })

  it('words each refusal in both locales: the flag by name, or why it is not honoured', () => {
    const ask = sellerVatRefusalMessage('not_confirmed', '21 EUR')
    expect(ask.sv).toContain(`${FOREIGN_SELLER_VAT_FLAG}=true`)
    expect(ask.en).toContain(`${FOREIGN_SELLER_VAT_FLAG}=true`)
    expect(ask.sv).toContain('21 EUR')
    const swedish = sellerVatRefusalMessage('seller_vat_swedish', '25 SEK')
    expect(swedish.sv).toMatch(/svensk moms/)
    expect(swedish.en).toMatch(/Swedish VAT/)
  })

  it('puts the whole amount paid in the box of the purchase: EU service 21, non-EU service 22, EU goods 20', () => {
    // Paid 121: a price of 100 and 21 foreign VAT. The basis is 121, never 100.
    for (const [kind, ruta] of [['eu_services', '21'], ['non_eu_services', '22'], ['eu_goods', '20']] as const) {
      const lines = generateReverseChargePurchaseLines({ base: 121, kind })
      const basis = lines.find((l) => l.debit_amount > 0 && ACCOUNT_TO_BOX[l.account_number] === ruta)
      expect(basis?.debit_amount).toBe(121)
      // Utgående moms in ruta 30 and the calculated ingående moms, both on 121.
      expect(lines.find((l) => l.account_number === '2614')?.credit_amount).toBe(30.25)
      expect(lines.find((l) => l.account_number === '2645')?.debit_amount).toBe(30.25)
      expect(lines.map((l) => l.account_number)).not.toContain('2641')
    }
  })
})
