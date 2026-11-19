import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { BUSINESS_EVENT_CATEGORIES } from '@/lib/posting/categories'
import {
  SE_PURCHASE_CATEGORY_ACCOUNTS,
  SE_PURCHASE_CATEGORY_PACK,
  sePurchaseCategoriesForAccount,
} from '@/lib/bookkeeping/bas-data/purchase-category-accounts'
import {
  getPurchaseCategory,
  isPurchaseCategoryCode,
  portCategoryFor,
  PURCHASE_CATEGORIES,
  PURCHASE_CATEGORY_CODES,
  PURCHASE_CATEGORY_GROUPS,
  PURCHASE_CATEGORY_VERSION,
  purchaseCategoryGroupNameKey,
  purchaseCategoryNameKey,
} from '../purchase-categories'

/**
 * The codes of pc-2026-10, pinned. Codes are permanent: a business event
 * stores the finest key it knows, so a renamed or removed code orphans every
 * event that carries it. Add codes (and bump the version), never take one
 * away.
 */
const PC_2026_10 = [
  'expense.software.saas', 'expense.software.licence', 'expense.software.cloud_hosting', 'expense.software.domains',
  'expense.software.services',
  'expense.telecom.mobile', 'expense.telecom.landline', 'expense.telecom.internet',
  'expense.office.supplies', 'expense.office.printing', 'expense.office.postage',
  'expense.premises.rent', 'expense.premises.electricity', 'expense.premises.heating', 'expense.premises.water',
  'expense.premises.cleaning', 'expense.premises.repairs', 'expense.premises.alarm',
  'expense.equipment.hardware', 'expense.equipment.furniture', 'expense.equipment.tools', 'expense.equipment.machinery',
  'expense.equipment.rental', 'expense.equipment.repairs',
  'expense.consumables.operating_supplies',
  'expense.vehicle.fuel', 'expense.vehicle.parking', 'expense.vehicle.repairs', 'expense.vehicle.leasing',
  'expense.vehicle.insurance_tax', 'expense.vehicle.congestion_tax', 'expense.vehicle.accessories',
  'expense.travel.flight', 'expense.travel.train', 'expense.travel.taxi', 'expense.travel.hotel', 'expense.travel.car_rental',
  'expense.travel.meals', 'expense.travel.other',
  'expense.representation.client', 'expense.representation.staff',
  'expense.marketing.ads', 'expense.marketing.print', 'expense.marketing.events', 'expense.marketing.gifts',
  'expense.marketing.sponsorship', 'expense.marketing.agency',
  'expense.professional_services.accounting', 'expense.professional_services.audit', 'expense.professional_services.legal',
  'expense.professional_services.tax_advice', 'expense.professional_services.consulting',
  'expense.professional_services.technical', 'expense.professional_services.staffing',
  'expense.goods.resale', 'expense.goods.materials', 'expense.goods.subcontracting', 'expense.goods.packaging',
  'expense.goods.freight', 'expense.goods.customs',
  'expense.personnel.health', 'expense.personnel.wellness', 'expense.personnel.recruitment', 'expense.personnel.workwear',
  'expense.personnel.gifts', 'expense.personnel.refreshments',
  'expense.education.training', 'expense.education.literature',
  'expense.insurance.business', 'expense.insurance.credit', 'expense.insurance.deductible',
  'expense.bank_fees.fees', 'expense.bank_fees.factoring',
  'expense.card_fees.payment_fees',
  'expense.fees.authorities', 'expense.fees.memberships', 'expense.fees.collection', 'expense.fees.royalties',
  'expense.fees.patents_trademarks',
]

/**
 * The shape business_events_category_check enforces (migration
 * 20261016220000_business_events on the building-blocks track, mirrored in
 * BUSINESS_EVENT_CATEGORY_PATTERN): a code stored as an event's category must
 * pass it.
 */
const BUSINESS_EVENT_CATEGORY_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/

type Names = { groups: Record<string, unknown>; categories: Record<string, unknown> }
const svNames = (sv as unknown as { purchaseCategories: Names }).purchaseCategories
const enNames = (en as unknown as { purchaseCategories: Names }).purchaseCategories

/** Every dotted path to a string in a nested name table. */
function leafKeys(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix]
  if (!node || typeof node !== 'object') return []
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  )
}

/** The string at a dotted key, as next-intl resolves it. */
function nameAt(table: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, segment) => (node as Record<string, unknown> | undefined)?.[segment], table)
}

describe('purchase category taxonomy', () => {
  it('is versioned', () => {
    expect(PURCHASE_CATEGORY_VERSION).toMatch(/^pc-\d{4}-\d{2}$/)
  })

  it('has unique codes in the stable <port key>.<item> format', () => {
    expect(new Set(PURCHASE_CATEGORY_CODES).size).toBe(PURCHASE_CATEGORY_CODES.length)
    for (const code of PURCHASE_CATEGORY_CODES) {
      expect(code).toMatch(/^[a-z]+\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)
      // Stored as a business event's category: the database's shape and length.
      expect(code).toMatch(BUSINESS_EVENT_CATEGORY_SHAPE)
      expect(code.length).toBeLessThanOrEqual(64)
    }
  })

  it('never drops or renames a pinned code, and grows only with a new version', () => {
    for (const code of PC_2026_10) expect(PURCHASE_CATEGORY_CODES).toContain(code)
    if (PURCHASE_CATEGORY_CODES.length !== PC_2026_10.length) {
      expect(PURCHASE_CATEGORY_VERSION).not.toBe('pc-2026-10')
    }
  })

  it('files every category under a known group, and every group has categories', () => {
    for (const category of PURCHASE_CATEGORIES) {
      expect(PURCHASE_CATEGORY_GROUPS).toContain(category.group)
      expect(category.code.startsWith(`${category.group}.`)).toBe(true)
      expect(category.nameKey).toBe(`categories.${category.code}`)
    }
    for (const group of PURCHASE_CATEGORY_GROUPS) {
      expect(PURCHASE_CATEGORIES.some((c) => c.group === group)).toBe(true)
    }
  })

  it('lists categories group by group, in group order', () => {
    const order = PURCHASE_CATEGORIES.map((c) => PURCHASE_CATEGORY_GROUPS.indexOf(c.group))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('stays a small taxonomy: about 15 groups and about 80 categories', () => {
    expect(PURCHASE_CATEGORY_GROUPS.length).toBeGreaterThanOrEqual(12)
    expect(PURCHASE_CATEGORY_GROUPS.length).toBeLessThanOrEqual(20)
    expect(PURCHASE_CATEGORY_CODES.length).toBeGreaterThanOrEqual(60)
    expect(PURCHASE_CATEGORY_CODES.length).toBeLessThanOrEqual(100)
  })

  it('recognises its own codes and nothing else', () => {
    expect(isPurchaseCategoryCode('expense.software.saas')).toBe(true)
    expect(isPurchaseCategoryCode('expense.software')).toBe(false)
    expect(isPurchaseCategoryCode('software.saas')).toBe(false)
    expect(isPurchaseCategoryCode('Expense.Software.SaaS')).toBe(false)
    expect(isPurchaseCategoryCode(42)).toBe(false)
    expect(getPurchaseCategory('expense.representation.client')?.group).toBe('expense.representation')
    expect(getPurchaseCategory('nope')).toBeUndefined()
  })
})

describe('portCategoryFor: the parent port key of a code', () => {
  it('gives every code exactly one parent: its first two segments', () => {
    for (const code of PURCHASE_CATEGORY_CODES) {
      const [top, key, item, ...rest] = code.split('.')
      expect(rest, code).toEqual([])
      expect(portCategoryFor(code)).toBe(`${top}.${key}`)
      expect(`${portCategoryFor(code)}.${item}`).toBe(code)
      expect(PURCHASE_CATEGORY_GROUPS.filter((group) => code.startsWith(`${group}.`))).toEqual([portCategoryFor(code)])
    }
  })

  it('is the group the category is listed under', () => {
    for (const category of PURCHASE_CATEGORIES) expect(portCategoryFor(category.code)).toBe(category.group)
  })

  it('names parents in the port key shape, never a code of its own', () => {
    for (const group of PURCHASE_CATEGORY_GROUPS) {
      expect(group).toMatch(/^[a-z]+\.[a-z][a-z0-9_]*$/)
      expect(group).toMatch(BUSINESS_EVENT_CATEGORY_SHAPE)
      expect(isPurchaseCategoryCode(group)).toBe(false)
    }
    expect(new Set(PURCHASE_CATEGORY_GROUPS).size).toBe(PURCHASE_CATEGORY_GROUPS.length)
  })

  it('keeps the parents of the pinned codes', () => {
    expect(portCategoryFor('expense.software.saas')).toBe('expense.software')
    expect(portCategoryFor('expense.equipment.hardware')).toBe('expense.equipment')
    expect(portCategoryFor('expense.travel.meals')).toBe('expense.travel')
    expect(portCategoryFor('expense.fees.collection')).toBe('expense.fees')
  })

  it('files every code under a key of the port\'s closed list', () => {
    const portKeys: readonly string[] = BUSINESS_EVENT_CATEGORIES.map((c) => c.key)
    for (const group of PURCHASE_CATEGORY_GROUPS) expect(portKeys).toContain(group)
    for (const code of PURCHASE_CATEGORY_CODES) expect(portKeys, code).toContain(portCategoryFor(code))
  })
})

describe('purchase category names (i18n)', () => {
  it.each([
    ['sv', svNames],
    ['en', enNames],
  ])('%s has a name for every group and category, and nothing else', (_locale, names) => {
    expect(Object.keys(names).sort()).toEqual(['categories', 'groups'])
    expect(leafKeys(names.groups).sort()).toEqual([...PURCHASE_CATEGORY_GROUPS].sort())
    for (const group of PURCHASE_CATEGORY_GROUPS) {
      const name = nameAt(names, purchaseCategoryGroupNameKey(group))
      expect(typeof name, group).toBe('string')
      expect((name as string).trim().length).toBeGreaterThan(0)
      expect(name as string).not.toMatch(/[\u2013\u2014]/)
    }
    expect(leafKeys(names.categories).sort()).toEqual([...PURCHASE_CATEGORY_CODES].sort())
    for (const code of PURCHASE_CATEGORY_CODES) {
      const name = nameAt(names, purchaseCategoryNameKey(code))
      expect(typeof name, code).toBe('string')
      expect((name as string).trim().length).toBeGreaterThan(0)
      expect(name as string).not.toMatch(/[\u2013\u2014]/)
    }
  })
})

describe('SE purchase category accounts', () => {
  const bas = new Map(BAS_REFERENCE.map((a) => [a.account_number, a]))

  it('maps every category to BAS accounts that exist in the 2026 chart', () => {
    for (const code of PURCHASE_CATEGORY_CODES) {
      const accounts = SE_PURCHASE_CATEGORY_ACCOUNTS[code]
      expect(accounts.length, code).toBeGreaterThan(0)
      expect(new Set(accounts).size, code).toBe(accounts.length)
      for (const account of accounts) {
        expect(typeof account).toBe('string')
        expect(account).toMatch(/^\d{4}$/)
        const row = bas.get(account)
        expect(row, `${code} -> ${account}`).toBeDefined()
        // A purchase lands on a cost account or, when it is capitalised, an asset.
        expect(['expense', 'asset'], `${code} -> ${account}`).toContain(row?.account_type)
      }
    }
  })

  it('maps nothing the taxonomy does not define', () => {
    expect(Object.keys(SE_PURCHASE_CATEGORY_ACCOUNTS).sort()).toEqual([...PURCHASE_CATEGORY_CODES].sort())
  })

  it('leaves out the reverse-charge basis accounts for services: they say how, not what', () => {
    const basis = ['4425', '4426', '4427', '4531', '4532', '4533', '4535', '4536', '4537', '4598']
    for (const code of PURCHASE_CATEGORY_CODES) {
      for (const account of SE_PURCHASE_CATEGORY_ACCOUNTS[code]) expect(basis).not.toContain(account)
    }
  })

  it('reverse-maps every listed account back to its categories', () => {
    for (const code of PURCHASE_CATEGORY_CODES) {
      for (const account of SE_PURCHASE_CATEGORY_ACCOUNTS[code]) {
        expect(sePurchaseCategoriesForAccount(account)).toContain(code)
      }
    }
  })

  it('reads an account owned by one category as that category alone', () => {
    expect(sePurchaseCategoriesForAccount('5611')).toEqual(['expense.vehicle.fuel'])
    expect(sePurchaseCategoriesForAccount('6530')).toEqual(['expense.professional_services.accounting'])
    expect(sePurchaseCategoriesForAccount('6212')).toEqual(['expense.telecom.mobile'])
    expect(sePurchaseCategoriesForAccount('5010')).toEqual(['expense.premises.rent'])
  })

  it('reads a shared account as candidates, never one answer', () => {
    expect(sePurchaseCategoriesForAccount('5410')).toEqual(
      expect.arrayContaining(['expense.equipment.hardware', 'expense.equipment.furniture', 'expense.equipment.tools']),
    )
    expect(sePurchaseCategoriesForAccount('5420')).toEqual(['expense.software.saas', 'expense.software.licence'])
    expect(sePurchaseCategoriesForAccount('5810').length).toBeGreaterThan(1)
  })

  it('reads a company sub-account like its BAS main account', () => {
    expect(sePurchaseCategoriesForAccount('5421')).toEqual(sePurchaseCategoriesForAccount('5420'))
    expect(sePurchaseCategoriesForAccount('6114')).toEqual(['expense.office.supplies'])
  })

  it('says nothing for an account it does not know or that is no account', () => {
    expect(sePurchaseCategoriesForAccount('1930')).toEqual([])
    expect(sePurchaseCategoriesForAccount('6990')).toEqual([])
    expect(sePurchaseCategoriesForAccount('')).toEqual([])
    expect(sePurchaseCategoriesForAccount('54200')).toEqual([])
    expect(sePurchaseCategoriesForAccount('abcd')).toEqual([])
  })

  it('serves the pack shape the country-neutral proposal takes', () => {
    expect(SE_PURCHASE_CATEGORY_PACK.country).toBe('SE')
    expect(SE_PURCHASE_CATEGORY_PACK.accountsFor('expense.software.saas')[0]).toBe('5420')
    expect(SE_PURCHASE_CATEGORY_PACK.categoriesFor('5611')).toEqual(['expense.vehicle.fuel'])
  })
})
