import { describe, expect, it } from 'vitest'
import {
  categoryOfLine,
  dominantLineCategory,
  LINE_ALTERNATIVE_SHARE,
  LINE_DOMINANT_SHARE,
  lineCategoryShares,
  MAX_PURCHASE_CATEGORY_ALTERNATIVES,
  merchantKindOfSupplierName,
  proposePurchaseCategory,
  purchaseCategoryAlternatives,
  STRONG_MIN_CLEAN_HITS,
  type PurchaseCategoryInput,
} from '../propose-purchase-category'
import { PURCHASE_CATEGORY_CODES, type PurchaseCategoryAccountPack } from '../purchase-categories'
import { PURCHASE_CATEGORY_KEYWORDS } from '../purchase-category-keywords'

const receipt = (
  lineItems: Array<{ description: string; lineTotal?: number }>,
  extra: Partial<NonNullable<PurchaseCategoryInput['extraction']>> = {},
): PurchaseCategoryInput['extraction'] => ({ documentKind: 'receipt', lineItems, ...extra })

describe('proposePurchaseCategory: the person decides first', () => {
  it('returns the person\'s own choice over any evidence', () => {
    expect(
      proposePurchaseCategory({
        override: 'expense.equipment.furniture',
        counterparty: { account: '5611', cleanHits: 40 },
        extraction: receipt([{ description: 'Bensin 95', lineTotal: 600 }], { merchantCategory: 'fuel' }),
      }),
    ).toEqual({ code: 'expense.equipment.furniture', source: 'person', level: 'Ditt val' })
  })

  it('keeps a person\'s choice even on a document that is not a purchase', () => {
    expect(
      proposePurchaseCategory({ override: 'expense.fees.authorities', extraction: { documentKind: 'government_letter' } }),
    ).toEqual({ code: 'expense.fees.authorities', source: 'person', level: 'Ditt val' })
  })

  it('ignores an override that is not a code of the taxonomy', () => {
    expect(
      proposePurchaseCategory({ override: 'software', counterparty: { account: '6212', cleanHits: 12 } }),
    ).toEqual({ code: 'expense.telecom.mobile', source: 'counterparty', level: 'Stark' })
  })
})

describe('proposePurchaseCategory: item override > supplier instruction > learned proposal', () => {
  const learned = {
    counterparty: { account: '5611', cleanHits: 40 },
    extraction: receipt([{ description: 'Bensin 95', lineTotal: 600 }], { merchantCategory: 'fuel' }),
  }

  it('the learned proposal stands when a person said nothing', () => {
    expect(proposePurchaseCategory(learned)).toEqual({ code: 'expense.vehicle.fuel', source: 'counterparty', level: 'Stark' })
  })

  it('a person\'s instruction for the supplier outranks everything learned, as Ditt val', () => {
    expect(proposePurchaseCategory({ ...learned, supplierInstruction: 'expense.equipment.tools' })).toEqual({
      code: 'expense.equipment.tools',
      source: 'instruction',
      level: 'Ditt val',
    })
  })

  it('a person\'s choice on the single item outranks the supplier instruction', () => {
    expect(
      proposePurchaseCategory({ ...learned, supplierInstruction: 'expense.equipment.tools', override: 'expense.office.supplies' }),
    ).toEqual({ code: 'expense.office.supplies', source: 'person', level: 'Ditt val' })
  })

  it('the instruction holds even on a document that is not a purchase, like the item choice', () => {
    expect(
      proposePurchaseCategory({ supplierInstruction: 'expense.professional_services.audit', extraction: { documentKind: 'other' } }),
    ).toEqual({ code: 'expense.professional_services.audit', source: 'instruction', level: 'Ditt val' })
  })

  it('ignores an instruction that is not a code of the taxonomy', () => {
    expect(proposePurchaseCategory({ ...learned, supplierInstruction: 'tools' })).toMatchObject({ source: 'counterparty' })
  })
})

describe('proposePurchaseCategory: no purchase, no proposal', () => {
  it.each(['government_letter', 'other'])('answers null for documentKind %s', (documentKind) => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '6212', cleanHits: 12 },
        extraction: { documentKind, lineItems: [{ description: 'Mobilabonnemang', lineTotal: 299 }] },
      }),
    ).toBeNull()
  })

  it('answers null when there is no evidence at all', () => {
    expect(proposePurchaseCategory({})).toBeNull()
    expect(proposePurchaseCategory({ extraction: receipt([]) })).toBeNull()
  })
})

describe('proposePurchaseCategory: the counterparty\'s booked history', () => {
  it('is Stark when the dominant account maps to one category and the history is clean', () => {
    expect(
      proposePurchaseCategory({ counterparty: { account: '6212', cleanHits: STRONG_MIN_CLEAN_HITS } }),
    ).toEqual({ code: 'expense.telecom.mobile', source: 'counterparty', level: 'Stark' })
    expect(proposePurchaseCategory({ counterparty: { account: '6530', cleanHits: 24 } })).toEqual({
      code: 'expense.professional_services.accounting',
      source: 'counterparty',
      level: 'Stark',
    })
  })

  it('is only Trolig while the history is thin', () => {
    expect(
      proposePurchaseCategory({ counterparty: { account: '6212', cleanHits: STRONG_MIN_CLEAN_HITS - 1 } }),
    ).toEqual({ code: 'expense.telecom.mobile', source: 'counterparty', level: 'Trolig' })
  })

  it('stays Stark when the lines agree with it', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5611', cleanHits: 9 },
        extraction: receipt([{ description: 'Diesel', lineTotal: 812.4 }], { merchantCategory: 'fuel' }),
      }),
    ).toEqual({ code: 'expense.vehicle.fuel', source: 'counterparty', level: 'Stark' })
  })

  it('reads a company sub-account like its BAS main account', () => {
    expect(proposePurchaseCategory({ counterparty: { account: '6214', cleanHits: 5 } })).toBeNull()
    expect(proposePurchaseCategory({ counterparty: { account: '6531', cleanHits: 5 } })).toEqual({
      code: 'expense.professional_services.accounting',
      source: 'counterparty',
      level: 'Stark',
    })
  })

  it('gives no answer from history alone when the account is shared by several categories', () => {
    expect(proposePurchaseCategory({ counterparty: { account: '5410', cleanHits: 30 } })).toBeNull()
    expect(proposePurchaseCategory({ counterparty: { account: '5420', cleanHits: 30 } })).toBeNull()
  })

  it('ignores an account that says nothing about what was bought', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '6990', cleanHits: 30 },
        extraction: receipt([{ description: 'Kontorsstol Markus', lineTotal: 1999 }]),
      }),
    ).toEqual({ code: 'expense.equipment.furniture', source: 'lines', level: 'Trolig' })
  })
})

describe('proposePurchaseCategory: mixed stores, the lines decide', () => {
  it('Clas Ohlson booked on 6110 for years, but this receipt is a drill: the lines win', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '6110', cleanHits: 14 },
        extraction: receipt(
          [
            { description: 'Bosch borrmaskin 18V', lineTotal: 1199.2 },
            { description: 'Bitsats 32 delar', lineTotal: 119.2 },
          ],
          { supplierName: 'Clas Ohlson AB' },
        ),
      }),
    ).toEqual({ code: 'expense.equipment.tools', source: 'lines', level: 'Trolig' })
  })

  it('Clas Ohlson on the shared 5410: the lines pick one of its categories, and the two agree', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5410', cleanHits: 8 },
        extraction: receipt([
          { description: 'Skrivbordslampa LED', lineTotal: 399.2 },
          { description: 'Förlängningssladd 3 m', lineTotal: 79.2 },
        ]),
      }),
    ).toEqual({ code: 'expense.equipment.furniture', source: 'counterparty', level: 'Stark' })
  })

  it('Biltema: oil and wiper blades are vehicle upkeep', () => {
    expect(
      proposePurchaseCategory({
        extraction: receipt(
          [
            { description: 'Motorolja 5W-30 4 l', lineTotal: 319.2 },
            { description: 'Torkarblad 2-pack', lineTotal: 199.2 },
            { description: 'Spolarvätska 4 l', lineTotal: 63.2 },
          ],
          { supplierName: 'Biltema Sweden AB' },
        ),
      }),
    ).toEqual({ code: 'expense.vehicle.repairs', source: 'lines', level: 'Trolig' })
  })

  it('Biltema: a bag of gloves, oil and a toolbox has no dominant category, so no guess', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5410', cleanHits: 8 },
        extraction: receipt([
          { description: 'Arbetshandskar', lineTotal: 119.2 },
          { description: 'Motorolja 5W-30', lineTotal: 319.2 },
          { description: 'Verktygslåda 19"', lineTotal: 399.2 },
        ]),
      }),
    ).toBeNull()
  })

  it('Amazon: the mouse decides, the shipping fee does not', () => {
    expect(
      proposePurchaseCategory({
        extraction: receipt([
          { description: 'Logitech MX Master 3S Wireless Mouse', lineTotal: 879.2 },
          { description: 'Frakt', lineTotal: 39.2 },
        ]),
      }),
    ).toEqual({ code: 'expense.equipment.hardware', source: 'lines', level: 'Trolig' })
  })

  it('Amazon: when only the shipping fee is recognised, the rest of the bag is unknown', () => {
    expect(
      proposePurchaseCategory({
        extraction: receipt([
          { description: 'Kindle Paperwhite 16 GB', lineTotal: 1599.2 },
          { description: 'Frakt', lineTotal: 39.2 },
        ]),
      }),
    ).toBeNull()
  })

  it('Amazon: a book is literature', () => {
    expect(
      proposePurchaseCategory({ extraction: receipt([{ description: 'Bok: Clean Code (häftad)', lineTotal: 389 }]) }),
    ).toEqual({ code: 'expense.education.literature', source: 'lines', level: 'Trolig' })
  })
})

describe('proposePurchaseCategory: lines on ordinary documents', () => {
  it('a SaaS invoice says subscription', () => {
    expect(
      proposePurchaseCategory({
        extraction: {
          documentKind: 'supplier_invoice',
          lineItems: [{ description: 'Slack Pro, monthly subscription (5 seats)', lineTotal: 437.5 }],
        },
      }),
    ).toEqual({ code: 'expense.software.saas', source: 'lines', level: 'Trolig' })
  })

  it('a newspaper subscription is literature: the thing outranks the generic word', () => {
    expect(
      proposePurchaseCategory({
        extraction: receipt([{ description: 'Prenumeration Dagens Industri, tidning 12 mån', lineTotal: 1490 }]),
      }),
    ).toEqual({ code: 'expense.education.literature', source: 'lines', level: 'Trolig' })
  })

  it('a hotel bill is the room, not the dinner beside it', () => {
    expect(
      proposePurchaseCategory({
        extraction: receipt(
          [
            { description: 'Logi 2 nätter', lineTotal: 2142.86 },
            { description: 'Middag', lineTotal: 401.79 },
          ],
          { merchantCategory: 'hotel' },
        ),
      }),
    ).toEqual({ code: 'expense.travel.hotel', source: 'lines', level: 'Trolig' })
  })

  it('a credit note is weighed by the size of its lines, not their sign', () => {
    expect(
      proposePurchaseCategory({
        extraction: {
          documentKind: 'credit_note',
          lineItems: [{ description: 'Kreditering: Kontorsstol Markus', lineTotal: -1599.2 }],
        },
      }),
    ).toEqual({ code: 'expense.equipment.furniture', source: 'lines', level: 'Trolig' })
  })

  it('counts lines when the document has no amounts', () => {
    expect(
      proposePurchaseCategory({
        extraction: receipt([
          { description: 'Kaffe', lineTotal: 0 },
          { description: 'Mjölk', lineTotal: 0 },
          { description: 'Kanelbulle' },
        ]),
      }),
    ).toEqual({ code: 'expense.personnel.refreshments', source: 'lines', level: 'Trolig' })
  })
})

describe('proposePurchaseCategory: a suggested account', () => {
  it('is Trolig when it maps to one category', () => {
    expect(proposePurchaseCategory({ suggestedAccount: '6530' })).toEqual({
      code: 'expense.professional_services.accounting',
      source: 'account',
      level: 'Trolig',
    })
  })

  it('decides a restaurant receipt that the merchant kind alone cannot', () => {
    expect(
      proposePurchaseCategory({
        suggestedAccount: '6071',
        extraction: receipt([], { merchantCategory: 'restaurant' }),
      }),
    ).toEqual({ code: 'expense.representation.client', source: 'account', level: 'Trolig' })
  })

  it('says nothing when the account is shared and nothing else helps', () => {
    expect(proposePurchaseCategory({ suggestedAccount: '5420' })).toBeNull()
  })

  it('ranks below the lines', () => {
    expect(
      proposePurchaseCategory({
        suggestedAccount: '6110',
        extraction: receipt([{ description: 'Kontorsstol Markus', lineTotal: 1999 }]),
      }),
    ).toEqual({ code: 'expense.equipment.furniture', source: 'lines', level: 'Trolig' })
  })
})

describe('proposePurchaseCategory: the merchant kind', () => {
  it.each([
    ['taxi', 'expense.travel.taxi'],
    ['parking', 'expense.vehicle.parking'],
    ['fuel', 'expense.vehicle.fuel'],
    ['hotel', 'expense.travel.hotel'],
  ])('%s means %s', (merchantCategory, code) => {
    expect(proposePurchaseCategory({ extraction: receipt([], { merchantCategory }) })).toEqual({
      code,
      source: 'merchant_category',
      level: 'Trolig',
    })
  })

  it.each(['restaurant', 'cafe', 'grocery'])('%s alone is ambiguous: null', (merchantCategory) => {
    expect(proposePurchaseCategory({ extraction: receipt([], { merchantCategory }) })).toBeNull()
  })

  it('"other" says nothing', () => {
    expect(proposePurchaseCategory({ extraction: receipt([], { merchantCategory: 'other' }) })).toBeNull()
  })

  it('a restaurant booked by this counterparty on Kost och logi, history still thin, is a meal on a trip', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5831', cleanHits: STRONG_MIN_CLEAN_HITS - 1 },
        extraction: receipt([], { merchantCategory: 'restaurant' }),
      }),
    ).toEqual({ code: 'expense.travel.meals', source: 'merchant_category', level: 'Trolig' })
  })

  it('a cafe with a personnel-cost account narrows to refreshments', () => {
    expect(
      proposePurchaseCategory({ suggestedAccount: '7690', extraction: receipt([], { merchantCategory: 'cafe' }) }),
    ).toEqual({ code: 'expense.personnel.refreshments', source: 'merchant_category', level: 'Trolig' })
  })

  it('a restaurant whose counterparty is on the client representation account is Stark', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '6072', cleanHits: 6 },
        extraction: receipt([], { merchantCategory: 'restaurant' }),
      }),
    ).toEqual({ code: 'expense.representation.client', source: 'counterparty', level: 'Stark' })
  })

  it('falls back to a generic word in the supplier name when extraction gave no kind', () => {
    expect(proposePurchaseCategory({ extraction: receipt([], { supplierName: 'Taxi Stockholm AB' }) })).toEqual({
      code: 'expense.travel.taxi',
      source: 'merchant_category',
      level: 'Trolig',
    })
    expect(
      proposePurchaseCategory({ extraction: receipt([], { merchantCategory: 'other', supplierName: 'Hotel Rival' }) }),
    ).toEqual({ code: 'expense.travel.hotel', source: 'merchant_category', level: 'Trolig' })
  })
})

describe('proposePurchaseCategory: the country pack is a parameter', () => {
  it('reads accounts through the pack it is given', () => {
    const pack: PurchaseCategoryAccountPack = {
      country: 'XX',
      accountsFor: () => [],
      categoriesFor: (account) => (account === 'X-100' ? ['expense.travel.flight'] : []),
    }
    expect(proposePurchaseCategory({ counterparty: { account: 'X-100', cleanHits: 7 } }, pack)).toEqual({
      code: 'expense.travel.flight',
      source: 'counterparty',
      level: 'Stark',
    })
    expect(proposePurchaseCategory({ counterparty: { account: '6212', cleanHits: 7 } }, pack)).toBeNull()
  })
})

describe('categoryOfLine', () => {
  it.each([
    ['Mobilabonnemang Telia 5G', 'expense.telecom.mobile'],
    ['Telia Mobilt bredband 4G', 'expense.telecom.internet'],
    ['IT-support 3 h', 'expense.software.services'],
    ['Datorsupport på plats', 'expense.software.services'],
    ['Tåg Stockholm C - Göteborg C', 'expense.travel.train'],
    ['Training course: Excel', 'expense.education.training'],
    ['Lenovo ThinkPad computer', 'expense.equipment.hardware'],
    ['Elastic Compute Cloud', 'expense.software.cloud_hosting'],
    ['Adobe Creative Cloud subscription', 'expense.software.saas'],
    ['Julbord 12 pers', 'expense.representation.staff'],
    ['Personalrepresentation', 'expense.representation.staff'],
    ['Representation kundmöte', 'expense.representation.client'],
    ['Representation', 'expense.representation.client'],
    ['Platsannons Blocket', 'expense.personnel.recruitment'],
    ['Returfrakt', 'expense.goods.freight'],
    ['Trängselskatt september', 'expense.vehicle.congestion_tax'],
    ['Licensavgift musik', 'expense.fees.royalties'],
  ])('"%s" is %s', (line, code) => {
    expect(categoryOfLine(line)).toBe(code)
  })

  it.each([
    ['Serveringsavgift', 'a whole-word keyword does not fire inside another word'],
    // accounted#92: a compound is what its last part names; a gift is no client meal.
    ['Representationsgåva', '"representation" opens the compound, it does not name it'],
    ['Price tag', 'diacritics are kept: "tag" is not "tåg"'],
    ['Advokat och revisor', 'two categories tie on equally specific words'],
    ['', 'an empty line'],
  ])('"%s" is undecided (%s)', (line) => {
    expect(categoryOfLine(line)).toBeNull()
  })
})

describe('dominantLineCategory', () => {
  it(`needs one category to carry ${LINE_DOMINANT_SHARE * 100} % of the line value`, () => {
    expect(
      dominantLineCategory([
        { description: 'Kontorsstol', lineTotal: 60 },
        { description: 'Okänd vara', lineTotal: 40 },
      ]),
    ).toBe('expense.equipment.furniture')
    expect(
      dominantLineCategory([
        { description: 'Kontorsstol', lineTotal: 59 },
        { description: 'Okänd vara', lineTotal: 41 },
      ]),
    ).toBeNull()
  })

  it('answers null for no lines', () => {
    expect(dominantLineCategory(null)).toBeNull()
    expect(dominantLineCategory([])).toBeNull()
  })
})

describe('merchantKindOfSupplierName', () => {
  it('reads one generic kind word and refuses two', () => {
    expect(merchantKindOfSupplierName('Restaurang Prinsen')).toBe('restaurant')
    expect(merchantKindOfSupplierName('Café Pascal')).toBe('cafe')
    expect(merchantKindOfSupplierName('Hotell & Restaurang Bryggan')).toBeNull()
    expect(merchantKindOfSupplierName('Clas Ohlson AB')).toBeNull()
    expect(merchantKindOfSupplierName(null)).toBeNull()
  })
})

describe('purchase category keywords', () => {
  it('only name categories of the taxonomy', () => {
    for (const code of Object.keys(PURCHASE_CATEGORY_KEYWORDS)) {
      expect(PURCHASE_CATEGORY_CODES as readonly string[]).toContain(code)
    }
  })

  it('never repeat a keyword across two categories', () => {
    const owner = new Map<string, string>()
    for (const [code, kw] of Object.entries(PURCHASE_CATEGORY_KEYWORDS)) {
      for (const word of [...(kw?.strong ?? []), ...(kw?.weak ?? [])]) {
        const key = word.replace(/^=/, '').toLowerCase()
        expect(owner.get(key), `"${word}" in ${code} and ${owner.get(key)}`).toBeUndefined()
        owner.set(key, code)
      }
    }
  })
})

describe('proposePurchaseCategory: a shared account and the document agreeing is Stark', () => {
  const slack = receipt([{ description: 'Slack Pro, monthly subscription (5 seats)', lineTotal: 437.5 }])

  it('clean history on 5420 and lines that say subscription', () => {
    expect(proposePurchaseCategory({ counterparty: { account: '5420', cleanHits: 12 }, extraction: slack })).toEqual({
      code: 'expense.software.saas',
      source: 'counterparty',
      level: 'Stark',
    })
  })

  it('clean history on 5420 and lines that say licence', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5420', cleanHits: 5 },
        extraction: receipt([{ description: 'JetBrains perpetual license, 1 user', lineTotal: 2490 }]),
      }),
    ).toEqual({ code: 'expense.software.licence', source: 'counterparty', level: 'Stark' })
  })

  it('stays Trolig while the history is thin', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5420', cleanHits: STRONG_MIN_CLEAN_HITS - 1 },
        extraction: slack,
      }),
    ).toEqual({ code: 'expense.software.saas', source: 'lines', level: 'Trolig' })
  })

  it('stays Trolig when the lines name a category the account does not hold', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5420', cleanHits: 12 },
        extraction: receipt([{ description: 'Kontorsstol Markus', lineTotal: 1999 }]),
      }),
    ).toEqual({ code: 'expense.equipment.furniture', source: 'lines', level: 'Trolig' })
  })

  it('clean history on Kost och logi and a hotel receipt', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5831', cleanHits: 6 },
        extraction: receipt([], { merchantCategory: 'hotel' }),
      }),
    ).toEqual({ code: 'expense.travel.hotel', source: 'counterparty', level: 'Stark' })
  })

  it('clean history on Kost och logi and a restaurant receipt: a meal on a trip', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5831', cleanHits: 4 },
        extraction: receipt([], { merchantCategory: 'restaurant' }),
      }),
    ).toEqual({ code: 'expense.travel.meals', source: 'counterparty', level: 'Stark' })
  })

  it('clean history on 5810 and a taxi slip', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5810', cleanHits: 9 },
        extraction: receipt([], { merchantCategory: 'taxi' }),
      }),
    ).toEqual({ code: 'expense.travel.taxi', source: 'counterparty', level: 'Stark' })
  })

  it('clean personnel-cost history and a cafe receipt narrow to refreshments', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '7690', cleanHits: 7 },
        extraction: receipt([], { merchantCategory: 'cafe' }),
      }),
    ).toEqual({ code: 'expense.personnel.refreshments', source: 'counterparty', level: 'Stark' })
  })

  it('outranks a suggested account that only says Trolig', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5831', cleanHits: 6 },
        suggestedAccount: '6071',
        extraction: receipt([], { merchantCategory: 'hotel' }),
      }),
    ).toEqual({ code: 'expense.travel.hotel', source: 'counterparty', level: 'Stark' })
  })

  it('a merchant kind that shares nothing with the account gives no answer', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '7690', cleanHits: 7 },
        extraction: receipt([], { merchantCategory: 'restaurant' }),
      }),
    ).toBeNull()
  })

  it('a mixed bag on a shared account is still no guess', () => {
    expect(
      proposePurchaseCategory({
        counterparty: { account: '5410', cleanHits: 30 },
        extraction: receipt([
          { description: 'Arbetshandskar', lineTotal: 119.2 },
          { description: 'Motorolja 5W-30', lineTotal: 319.2 },
          { description: 'Verktygslåda 19"', lineTotal: 399.2 },
        ]),
      }),
    ).toBeNull()
  })
})

describe('lineCategoryShares', () => {
  it('weighs each named category by amount, the undecided lines counted in the whole', () => {
    expect(
      lineCategoryShares([
        { description: 'Kontorsstol', lineTotal: 300 },
        { description: 'Skruvdragare', lineTotal: 500 },
        { description: 'Okänd sak', lineTotal: 200 },
      ]),
    ).toEqual([
      { code: 'expense.equipment.tools', share: 0.5 },
      { code: 'expense.equipment.furniture', share: 0.3 },
    ])
  })

  it('counts lines when the document has no amounts, and keeps line order on a tie', () => {
    expect(lineCategoryShares([{ description: 'Kontorsstol' }, { description: 'Skruvdragare' }])).toEqual([
      { code: 'expense.equipment.furniture', share: 0.5 },
      { code: 'expense.equipment.tools', share: 0.5 },
    ])
  })

  it('is empty without lines', () => {
    expect(lineCategoryShares(null)).toEqual([])
    expect(lineCategoryShares([])).toEqual([])
  })
})

describe('purchaseCategoryAlternatives', () => {
  it('offers what a restaurant receipt can mean, where the proposal stays null', () => {
    const input: PurchaseCategoryInput = { extraction: receipt([], { merchantCategory: 'restaurant' }) }
    expect(proposePurchaseCategory(input)).toBeNull()
    expect(purchaseCategoryAlternatives(input)).toEqual([
      { code: 'expense.representation.client', source: 'merchant_category' },
      { code: 'expense.representation.staff', source: 'merchant_category' },
      { code: 'expense.travel.meals', source: 'merchant_category' },
    ])
  })

  it('offers the categories of a shared booked account, at most the limit', () => {
    const input: PurchaseCategoryInput = { counterparty: { account: '5410', cleanHits: 9 } }
    expect(proposePurchaseCategory(input)).toBeNull()
    const alternatives = purchaseCategoryAlternatives(input)
    expect(alternatives).toHaveLength(MAX_PURCHASE_CATEGORY_ALTERNATIVES)
    expect(alternatives).toEqual([
      { code: 'expense.equipment.hardware', source: 'counterparty' },
      { code: 'expense.equipment.furniture', source: 'counterparty' },
      { code: 'expense.equipment.tools', source: 'counterparty' },
    ])
    expect(purchaseCategoryAlternatives(input, undefined, 1)).toHaveLength(1)
    expect(purchaseCategoryAlternatives(input, undefined, 0)).toEqual([])
  })

  it('puts a category two sources agree on first', () => {
    // The chair carries 40 percent: too little to decide, enough to agree with the history.
    const input: PurchaseCategoryInput = {
      counterparty: { account: '5410', cleanHits: 9 },
      extraction: receipt([
        { description: 'Kontorsstol', lineTotal: 400 },
        { description: 'Okänd sak', lineTotal: 600 },
      ]),
    }
    expect(proposePurchaseCategory(input)).toBeNull()
    expect(purchaseCategoryAlternatives(input).map((a) => a.code)).toEqual([
      'expense.equipment.furniture',
      'expense.equipment.hardware',
      'expense.equipment.tools',
    ])
  })

  it('puts a category the lines name alone before the categories of a shared account', () => {
    // A hardware store booked on 5410: the drill decides, the paint is the lines' own second word.
    const input: PurchaseCategoryInput = {
      counterparty: { account: '5410', cleanHits: 9 },
      extraction: receipt([
        { description: 'Skruvdragare', lineTotal: 700 },
        { description: 'Färg', lineTotal: 300 },
      ]),
    }
    expect(proposePurchaseCategory(input)).toMatchObject({ code: 'expense.equipment.tools', source: 'counterparty', level: 'Stark' })
    expect(purchaseCategoryAlternatives(input)).toEqual([
      { code: 'expense.goods.materials', source: 'lines' },
      { code: 'expense.equipment.hardware', source: 'counterparty' },
      { code: 'expense.equipment.furniture', source: 'counterparty' },
    ])
  })

  it('offers the booked history when the lines of a mixed store win the proposal', () => {
    const input: PurchaseCategoryInput = {
      counterparty: { account: '6110', cleanHits: 20 },
      extraction: receipt([{ description: 'Skruvdragare', lineTotal: 1200 }]),
    }
    expect(proposePurchaseCategory(input)).toMatchObject({ code: 'expense.equipment.tools', source: 'lines' })
    expect(purchaseCategoryAlternatives(input)).toEqual([{ code: 'expense.office.supplies', source: 'counterparty' }])
  })

  it('never offers the proposal itself, and invents nothing when the evidence names one category', () => {
    const input: PurchaseCategoryInput = { extraction: receipt([], { merchantCategory: 'taxi' }) }
    expect(proposePurchaseCategory(input)?.code).toBe('expense.travel.taxi')
    expect(purchaseCategoryAlternatives(input)).toEqual([])
    expect(purchaseCategoryAlternatives({})).toEqual([])
  })

  it('offers what the evidence alone proposes under a person\'s choice', () => {
    const input: PurchaseCategoryInput = {
      override: 'expense.equipment.furniture',
      counterparty: { account: '6212', cleanHits: 12 },
    }
    expect(purchaseCategoryAlternatives(input)).toEqual([{ code: 'expense.telecom.mobile', source: 'counterparty' }])
  })

  it('offers the supplier\'s instruction first when a choice on this underlag outranks it', () => {
    const input: PurchaseCategoryInput = {
      override: 'expense.equipment.furniture',
      supplierInstruction: 'expense.telecom.internet',
      counterparty: { account: '6212', cleanHits: 12 },
    }
    expect(purchaseCategoryAlternatives(input)).toEqual([
      { code: 'expense.telecom.internet', source: 'instruction' },
      { code: 'expense.telecom.mobile', source: 'counterparty' },
    ])
  })

  it('offers the history under the supplier\'s instruction', () => {
    const input: PurchaseCategoryInput = {
      supplierInstruction: 'expense.telecom.internet',
      counterparty: { account: '6212', cleanHits: 12 },
    }
    expect(proposePurchaseCategory(input)?.source).toBe('instruction')
    expect(purchaseCategoryAlternatives(input)).toEqual([{ code: 'expense.telecom.mobile', source: 'counterparty' }])
  })

  it('offers lines only from LINE_ALTERNATIVE_SHARE of the document', () => {
    const shipping = (share: number): PurchaseCategoryInput => ({
      extraction: receipt([
        { description: 'Frakt', lineTotal: share * 1000 },
        { description: 'Okänd sak', lineTotal: (1 - share) * 1000 },
      ]),
    })
    expect(purchaseCategoryAlternatives(shipping(0.05))).toEqual([])
    expect(purchaseCategoryAlternatives(shipping(LINE_ALTERNATIVE_SHARE))).toEqual([
      { code: 'expense.goods.freight', source: 'lines' },
    ])
  })

  it('offers only a person\'s instruction on a document that is not a purchase', () => {
    expect(
      purchaseCategoryAlternatives({
        override: 'expense.fees.authorities',
        supplierInstruction: 'expense.fees.memberships',
        extraction: { documentKind: 'government_letter', merchantCategory: 'restaurant' },
      }),
    ).toEqual([{ code: 'expense.fees.memberships', source: 'instruction' }])
    expect(
      purchaseCategoryAlternatives({ extraction: { documentKind: 'government_letter', merchantCategory: 'restaurant' } }),
    ).toEqual([])
  })
})
