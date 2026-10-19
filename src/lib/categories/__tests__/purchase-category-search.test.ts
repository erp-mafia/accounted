import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import {
  buildPurchaseCategorySearchIndex,
  foldSearchText,
  searchPurchaseCategories,
} from '../purchase-category-search'
import {
  PURCHASE_CATEGORY_CODES,
  purchaseCategoryGroupNameKey,
  purchaseCategoryNameKey,
} from '../purchase-categories'

/** The names as next-intl reads them: dotted keys nest. */
function namesOf(messages: { purchaseCategories: unknown }) {
  const lookup = (key: string) =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages.purchaseCategories) as string
  return {
    category: (code: Parameters<typeof purchaseCategoryNameKey>[0]) => lookup(purchaseCategoryNameKey(code)),
    group: (group: Parameters<typeof purchaseCategoryGroupNameKey>[0]) => lookup(purchaseCategoryGroupNameKey(group)),
  }
}

const SV = buildPurchaseCategorySearchIndex(namesOf(sv))
const EN = buildPurchaseCategorySearchIndex(namesOf(en))

describe('foldSearchText', () => {
  it('folds case, diacritics and punctuation', () => {
    expect(foldSearchText('Tåg, buss och kollektivtrafik')).toBe('tag buss och kollektivtrafik')
    expect(foldSearchText('  IT-support  ')).toBe('it support')
    expect(foldSearchText('Kontorsmöbler & Inredning')).toBe('kontorsmobler inredning')
    expect(foldSearchText('Café')).toBe('cafe')
    expect(foldSearchText(' , ')).toBe('')
  })
})

describe('searchPurchaseCategories', () => {
  it('ranks the name hit first: "tax" finds Taxi before the tax advice a keyword names', () => {
    const hits = searchPurchaseCategories(SV, 'tax')
    expect(hits[0]).toBe('expense.travel.taxi')
    expect(hits).toContain('expense.professional_services.tax_advice')
  })

  it('matches inside a compound: "kollektiv" finds Tåg, buss och kollektivtrafik', () => {
    expect(searchPurchaseCategories(SV, 'kollektiv')).toEqual(['expense.travel.train'])
  })

  it('ignores accents and case', () => {
    expect(searchPurchaseCategories(SV, 'TAG')[0]).toBe('expense.travel.train')
    expect(searchPurchaseCategories(SV, 'kontorsmobler')).toEqual(['expense.equipment.furniture'])
  })

  it('ignores punctuation in the name and the query', () => {
    expect(searchPurchaseCategories(SV, 'it-support')[0]).toBe('expense.software.services')
    expect(searchPurchaseCategories(SV, 'it support')[0]).toBe('expense.software.services')
  })

  it('needs every typed word to match, in any order', () => {
    expect(searchPurchaseCategories(SV, 'buss tåg')).toEqual(['expense.travel.train'])
    expect(searchPurchaseCategories(SV, 'taxi hotell')).toEqual([])
  })

  it('finds a whole group by its name, in display order', () => {
    const hits = searchPurchaseCategories(SV, 'resor')
    expect(hits.slice(0, 7)).toEqual([
      'expense.travel.flight',
      'expense.travel.train',
      'expense.travel.taxi',
      'expense.travel.hotel',
      'expense.travel.car_rental',
      'expense.travel.meals',
      'expense.travel.other',
    ])
  })

  it('finds a category by a keyword the name does not carry, in either language', () => {
    expect(searchPurchaseCategories(SV, 'stol')).toEqual(['expense.equipment.furniture'])
    expect(searchPurchaseCategories(SV, 'chair')).toEqual(['expense.equipment.furniture'])
    expect(searchPurchaseCategories(EN, 'stol')).toEqual(['expense.equipment.furniture'])
    // A keyword written for whole-word line matching ('=server') is plain text here.
    expect(searchPurchaseCategories(SV, 'server')).toContain('expense.software.cloud_hosting')
  })

  it('matches a keyword from the start of its words only', () => {
    // 'ord' sits inside the furniture keywords 'bord' and 'skrivbord' but starts none of their words.
    expect(searchPurchaseCategories(SV, 'ord')).not.toContain('expense.equipment.furniture')
  })

  it('reads the English names in the English index', () => {
    expect(searchPurchaseCategories(EN, 'taxi')[0]).toBe('expense.travel.taxi')
    expect(searchPurchaseCategories(EN, 'public transport')[0]).toBe('expense.travel.train')
    expect(searchPurchaseCategories(EN, 'furniture')[0]).toBe('expense.equipment.furniture')
  })

  it('answers every category in display order for an empty query, and nothing for a miss', () => {
    expect(searchPurchaseCategories(SV, '')).toEqual([...PURCHASE_CATEGORY_CODES])
    expect(searchPurchaseCategories(SV, '   ')).toEqual([...PURCHASE_CATEGORY_CODES])
    expect(searchPurchaseCategories(SV, 'zzzz')).toEqual([])
  })
})
