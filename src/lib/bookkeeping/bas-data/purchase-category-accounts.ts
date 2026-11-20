/**
 * The Swedish (SE) country pack's half of the purchase-category taxonomy:
 * which BAS 2026 accounts each category (lib/categories/purchase-categories.ts)
 * is typically booked on, and the reverse.
 *
 * This is about accounts only, never tax treatment. Where BAS splits one kind
 * of purchase by deductibility or VAT (6071 / 6072, 7631 / 7632, 5981 /
 * 5982) both accounts are listed and nothing here says which one applies.
 * The reverse-charge basis accounts for services (4425, 4531, 4535 and their
 * kin, rutor 21, 22 and 24) are left out on purpose: they record how a
 * purchase is declared, not what was bought, and a learned line pattern
 * carries them beside the real cost line.
 *
 * List every account a category is commonly booked on, not only the textbook
 * one. The reverse map is what a proposal trusts when it reads a booked
 * account, and an account it believes belongs to one category alone yields
 * a strong proposal: leaving out a common second home for a category (cloud
 * hosting on 6540 beside 6230) would turn that account into a false unique.
 * Every account is checked against the BAS chart in this directory by
 * lib/categories/__tests__/purchase-categories.test.ts.
 *
 * Lives under bas-data/ because it is Swedish chart knowledge: the future SE
 * jurisdiction pack (SE_PACK_TERRITORY in scripts/checks/jurisdiction-welds.mjs).
 */
import type {
  PurchaseCategoryAccountPack,
  PurchaseCategoryCode,
} from '@/lib/categories/purchase-categories'
import { PURCHASE_CATEGORY_CODES } from '@/lib/categories/purchase-categories'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'

/** Typical BAS accounts per category, the usual one first. */
export const SE_PURCHASE_CATEGORY_ACCOUNTS: Readonly<Record<PurchaseCategoryCode, readonly string[]>> = {
  'expense.software.saas': ['5420', '6540'],
  'expense.software.licence': ['5420'],
  'expense.software.cloud_hosting': ['6230', '6540'],
  'expense.software.domains': ['6230'],
  'expense.software.services': ['6540'],

  'expense.telecom.mobile': ['6212'],
  'expense.telecom.landline': ['6211'],
  'expense.telecom.internet': ['6230'],

  'expense.office.supplies': ['6110'],
  'expense.office.printing': ['6150'],
  'expense.office.postage': ['6250'],

  'expense.premises.rent': ['5010', '5011', '5012', '5013'],
  'expense.premises.electricity': ['5020', '5120'],
  'expense.premises.heating': ['5030', '5130'],
  'expense.premises.water': ['5040', '5140'],
  'expense.premises.cleaning': ['5060', '5061', '5062', '5160'],
  'expense.premises.repairs': ['5070', '5170'],
  'expense.premises.alarm': ['6370'],

  'expense.equipment.hardware': ['5410', '1224', '1220'],
  'expense.equipment.furniture': ['5410', '1220'],
  'expense.equipment.tools': ['5410', '1220'],
  'expense.equipment.machinery': ['1210', '5410'],
  'expense.equipment.rental': ['5220', '5210', '5250'],
  'expense.equipment.repairs': ['5520', '5510'],

  'expense.consumables.operating_supplies': ['5460'],

  'expense.vehicle.fuel': ['5611', '5621'],
  'expense.vehicle.parking': ['5619', '5890'],
  'expense.vehicle.repairs': ['5613', '5623'],
  'expense.vehicle.leasing': ['5615', '5625'],
  'expense.vehicle.insurance_tax': ['5612', '5622'],
  'expense.vehicle.congestion_tax': ['5616', '5626'],
  'expense.vehicle.accessories': ['5619'],

  'expense.travel.flight': ['5810'],
  'expense.travel.train': ['5810'],
  'expense.travel.taxi': ['5810', '5890'],
  'expense.travel.hotel': ['5831', '5832', '5830'],
  'expense.travel.car_rental': ['5820'],
  'expense.travel.meals': ['5831', '5832', '5830'],
  'expense.travel.other': ['5890'],

  // The usual account is the ej avdragsgill one: what lands here is nearly
  // always a meal, not income-tax deductible since 2017 (IL 16 kap. 2 §), and
  // the Inkorg's costAccountFor books the first account (accounted#86).
  'expense.representation.client': ['6072', '6071', '6070'],
  'expense.representation.staff': ['7632', '7631', '7630'],

  'expense.marketing.ads': ['5910', '5970'],
  'expense.marketing.print': ['5930'],
  'expense.marketing.events': ['5940'],
  'expense.marketing.gifts': ['5960'],
  'expense.marketing.sponsorship': ['5980', '5981', '5982'],
  'expense.marketing.agency': ['5990'],

  'expense.professional_services.accounting': ['6530'],
  'expense.professional_services.audit': ['6420', '6421', '6422'],
  'expense.professional_services.legal': ['6580'],
  'expense.professional_services.tax_advice': ['6555', '6423'],
  'expense.professional_services.consulting': ['6550', '6559', '6554'],
  'expense.professional_services.technical': ['6553', '6551', '6552'],
  'expense.professional_services.staffing': ['6890', '6810', '6840', '6850'],

  'expense.goods.resale': ['4010', '4070', '4075', '4080', '4085'],
  'expense.goods.materials': ['4310', '4510', '4515', '4540', '4545'],
  'expense.goods.subcontracting': ['4610', '4670'],
  'expense.goods.packaging': ['5440', '5460'],
  'expense.goods.freight': ['5710', '5711', '5790'],
  'expense.goods.customs': ['5720', '5721', '5722'],

  'expense.personnel.health': ['7620', '7621', '7622'],
  'expense.personnel.wellness': ['7699', '7690'],
  'expense.personnel.recruitment': ['7691'],
  'expense.personnel.workwear': ['5480'],
  'expense.personnel.gifts': ['7690', '7699'],
  'expense.personnel.refreshments': ['7690', '7699'],

  'expense.education.training': ['7610'],
  'expense.education.literature': ['6970'],

  'expense.insurance.business': ['6310'],
  'expense.insurance.credit': ['6063'],
  'expense.insurance.deductible': ['6320'],

  'expense.bank_fees.fees': ['6570'],
  'expense.bank_fees.factoring': ['6064'],

  'expense.card_fees.payment_fees': ['6040', '6570'],

  'expense.fees.authorities': ['6950', '6940'],
  'expense.fees.memberships': ['6980', '6981', '6982', '6560'],
  'expense.fees.collection': ['6061', '6062'],
  'expense.fees.royalties': ['6910'],
  'expense.fees.patents_trademarks': ['6920', '6930'],
}

/** Account → every category listing it, in taxonomy display order. */
const CATEGORIES_BY_ACCOUNT: ReadonlyMap<string, readonly PurchaseCategoryCode[]> = (() => {
  const map = new Map<string, PurchaseCategoryCode[]>()
  for (const code of PURCHASE_CATEGORY_CODES) {
    for (const account of SE_PURCHASE_CATEGORY_ACCOUNTS[code]) {
      const list = map.get(account) ?? []
      list.push(code)
      map.set(account, list)
    }
  }
  return map
})()

const NONE: readonly PurchaseCategoryCode[] = Object.freeze([])

/**
 * The candidate categories for a BAS account. An account this map does not
 * list falls back to its BAS main account (the 3-digit group plus '0'), so a
 * company's own sub-account (5421 under 5420) reads like its parent. Empty
 * when neither is mapped: the account says nothing about what was bought.
 */
export function sePurchaseCategoriesForAccount(account: string): readonly PurchaseCategoryCode[] {
  if (!ACCOUNT_NUMBER_RE.test(account)) return NONE
  const exact = CATEGORIES_BY_ACCOUNT.get(account)
  if (exact) return exact
  const main = `${account.slice(0, 3)}0`
  return CATEGORIES_BY_ACCOUNT.get(main) ?? NONE
}

/** The SE pack in the shape the country-neutral proposal takes. */
export const SE_PURCHASE_CATEGORY_PACK: PurchaseCategoryAccountPack = {
  country: 'SE',
  accountsFor: (code) => SE_PURCHASE_CATEGORY_ACCOUNTS[code] ?? NONE,
  categoriesFor: sePurchaseCategoriesForAccount,
}
