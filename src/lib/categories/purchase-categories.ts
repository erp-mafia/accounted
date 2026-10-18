/**
 * Purchase categories: WHAT was bought ("software subscription", "office
 * furniture"), as opposed to the account, which says how it was booked. The
 * two differ: a subscription can sit on 5420 or 6540, and 5410 holds
 * computers, furniture and tools alike.
 *
 * One list with the posting port's business-event categories
 * (src/lib/posting/categories.ts): the port's keys are the top level, and
 * these codes are their children. A code is '<port key>.<item>'
 * (expense.software.saas under expense.software), so its parent is always
 * its first two segments (portCategoryFor). A business event stores the
 * finest key it knows: the purchase code when the inbox has one, else the
 * port key (the port accepts both, isBusinessEventCategory), and a reader of
 * either gets the port key back by dropping the item.
 *
 * Codes are stable, dotted, English identifiers that never change meaning and
 * are never reused, since events are kept seven years. A code that has to go
 * is deprecated, not deleted, and a change of meaning is a new code under a
 * new PURCHASE_CATEGORY_VERSION. A parent is always an existing port key;
 * this file never invents one. This module is country-neutral: which
 * accounts a category is typically booked on is jurisdiction knowledge and
 * lives in the country pack (Sweden:
 * lib/bookkeeping/bas-data/purchase-category-accounts.ts), never here.
 *
 * Display names are i18n keys under the purchaseCategories namespace in
 * messages/sv.json and messages/en.json: groups.<port key> and
 * categories.<code> (next-intl nests on the dots).
 */

/** Version of the code list. Bump when codes are added or deprecated. */
export const PURCHASE_CATEGORY_VERSION = 'pc-2026-10' as const

/** The i18n namespace holding group and category names. */
export const PURCHASE_CATEGORY_I18N_NAMESPACE = 'purchaseCategories' as const

/**
 * The port keys the categories are children of, in display order: the
 * inbox's groups. Every entry is a key of the port's closed list
 * (BUSINESS_EVENT_CATEGORIES); a category's group is its parent
 * (portCategoryFor).
 */
export const PURCHASE_CATEGORY_GROUPS = [
  'expense.software',
  'expense.telecom',
  'expense.office',
  'expense.premises',
  'expense.equipment',
  'expense.consumables',
  'expense.vehicle',
  'expense.travel',
  'expense.representation',
  'expense.marketing',
  'expense.professional_services',
  'expense.goods',
  'expense.personnel',
  'expense.education',
  'expense.insurance',
  'expense.bank_fees',
  'expense.card_fees',
  'expense.fees',
] as const

export type PurchaseCategoryGroup = (typeof PURCHASE_CATEGORY_GROUPS)[number]

/** Every code of version pc-2026-10, '<port key>.<item>', parent by parent in display order. */
export const PURCHASE_CATEGORY_CODES = [
  'expense.software.saas',
  'expense.software.licence',
  'expense.software.cloud_hosting',
  'expense.software.domains',
  'expense.software.services',

  'expense.telecom.mobile',
  'expense.telecom.landline',
  'expense.telecom.internet',

  'expense.office.supplies',
  'expense.office.printing',
  'expense.office.postage',

  'expense.premises.rent',
  'expense.premises.electricity',
  'expense.premises.heating',
  'expense.premises.water',
  'expense.premises.cleaning',
  'expense.premises.repairs',
  'expense.premises.alarm',

  'expense.equipment.hardware',
  'expense.equipment.furniture',
  'expense.equipment.tools',
  'expense.equipment.machinery',
  'expense.equipment.rental',
  'expense.equipment.repairs',

  'expense.consumables.operating_supplies',

  'expense.vehicle.fuel',
  'expense.vehicle.parking',
  'expense.vehicle.repairs',
  'expense.vehicle.leasing',
  'expense.vehicle.insurance_tax',
  'expense.vehicle.congestion_tax',
  'expense.vehicle.accessories',

  'expense.travel.flight',
  'expense.travel.train',
  'expense.travel.taxi',
  'expense.travel.hotel',
  'expense.travel.car_rental',
  'expense.travel.meals',
  'expense.travel.other',

  'expense.representation.client',
  'expense.representation.staff',

  'expense.marketing.ads',
  'expense.marketing.print',
  'expense.marketing.events',
  'expense.marketing.gifts',
  'expense.marketing.sponsorship',
  'expense.marketing.agency',

  'expense.professional_services.accounting',
  'expense.professional_services.audit',
  'expense.professional_services.legal',
  'expense.professional_services.tax_advice',
  'expense.professional_services.consulting',
  'expense.professional_services.technical',
  'expense.professional_services.staffing',

  'expense.goods.resale',
  'expense.goods.materials',
  'expense.goods.subcontracting',
  'expense.goods.packaging',
  'expense.goods.freight',
  'expense.goods.customs',

  'expense.personnel.health',
  'expense.personnel.wellness',
  'expense.personnel.recruitment',
  'expense.personnel.workwear',
  'expense.personnel.gifts',
  'expense.personnel.refreshments',

  'expense.education.training',
  'expense.education.literature',

  'expense.insurance.business',
  'expense.insurance.credit',
  'expense.insurance.deductible',

  'expense.bank_fees.fees',
  'expense.bank_fees.factoring',

  'expense.card_fees.payment_fees',

  'expense.fees.authorities',
  'expense.fees.memberships',
  'expense.fees.collection',
  'expense.fees.royalties',
  'expense.fees.patents_trademarks',
] as const

export type PurchaseCategoryCode = (typeof PURCHASE_CATEGORY_CODES)[number]

export interface PurchaseCategory {
  code: PurchaseCategoryCode
  /** The parent port key (portCategoryFor). */
  group: PurchaseCategoryGroup
  /** Key under the purchaseCategories namespace: t(nameKey). */
  nameKey: string
}

/** The i18n key of a group's name under the purchaseCategories namespace. */
export function purchaseCategoryGroupNameKey(group: PurchaseCategoryGroup): string {
  return `groups.${group}`
}

/** The i18n key of a category's name under the purchaseCategories namespace. */
export function purchaseCategoryNameKey(code: PurchaseCategoryCode): string {
  return `categories.${code}`
}

/**
 * The port key a code is a child of: its first two segments
 * (expense.software.saas -> expense.software). This is what a business event
 * carrying the code reads as its top-level category.
 */
export function portCategoryFor(code: PurchaseCategoryCode): PurchaseCategoryGroup {
  return code.slice(0, code.lastIndexOf('.')) as PurchaseCategoryGroup
}

/** The categories in display order, with their group and name key. */
export const PURCHASE_CATEGORIES: readonly PurchaseCategory[] = Object.freeze(
  PURCHASE_CATEGORY_CODES.map((code) =>
    Object.freeze({ code, group: portCategoryFor(code), nameKey: purchaseCategoryNameKey(code) }),
  ),
)

const CODE_SET: ReadonlySet<string> = new Set(PURCHASE_CATEGORY_CODES)

/** Narrows a string to a code of the current version. */
export function isPurchaseCategoryCode(value: unknown): value is PurchaseCategoryCode {
  return typeof value === 'string' && CODE_SET.has(value)
}

/** The category of a code, or undefined for anything that is not one. */
export function getPurchaseCategory(code: string): PurchaseCategory | undefined {
  return isPurchaseCategoryCode(code) ? PURCHASE_CATEGORIES.find((c) => c.code === code) : undefined
}

/**
 * A country pack's view of the taxonomy: which accounts a category is
 * typically booked on, and the reverse. The reverse is a candidate list, not
 * an answer: an account shared by several categories (5410 holds computers,
 * furniture and tools) says only that it is one of them.
 */
export interface PurchaseCategoryAccountPack {
  /** ISO 3166-1 alpha-2 of the jurisdiction whose chart the accounts belong to. */
  country: string
  /** Typical accounts for a category, the usual one first. Empty when the chart has none. */
  accountsFor(code: PurchaseCategoryCode): readonly string[]
  /** Every category typically booked on this account, in display order. */
  categoriesFor(account: string): readonly PurchaseCategoryCode[]
}
