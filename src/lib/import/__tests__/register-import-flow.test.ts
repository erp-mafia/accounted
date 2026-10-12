import { describe, it, expect } from 'vitest'
import {
  columnsToMapping,
  countMatchedRows,
  mappingToOverrides,
  needsColumnMapping,
  registerImportEndpoint,
  registerSteps,
  rowsForExecute,
} from '../register-import-flow'
import type { DetectedCustomerColumns } from '../customers/types'
import type { DetectedSupplierColumns } from '../suppliers/types'
import type { DetectedArticleColumns } from '../articles/types'

/*
 * Parity with the three hand-written flows the import page had per register
 * (CustomersFlow, SuppliersFlow, ArticlesFlow): each built its overrides key
 * by key and stripped the same review fields before execute. The legacy
 * builders below are those bodies, verbatim.
 */
type Mapping<C> = Record<Exclude<keyof C, 'confidence'>, number | null>

function legacyCustomerOverrides(mapping: Mapping<DetectedCustomerColumns>): DetectedCustomerColumns {
  return {
    name_col: mapping.name_col ?? 0,
    customer_number_col: mapping.customer_number_col,
    org_number_col: mapping.org_number_col,
    customer_type_col: mapping.customer_type_col,
    email_col: mapping.email_col,
    phone_col: mapping.phone_col,
    address_line1_col: mapping.address_line1_col,
    address_line2_col: mapping.address_line2_col,
    postal_code_col: mapping.postal_code_col,
    city_col: mapping.city_col,
    country_col: mapping.country_col,
    vat_number_col: mapping.vat_number_col,
    payment_terms_col: mapping.payment_terms_col,
    notes_col: mapping.notes_col,
    confidence: 1,
  }
}

function legacySupplierOverrides(mapping: Mapping<DetectedSupplierColumns>): DetectedSupplierColumns {
  return {
    name_col: mapping.name_col ?? 0,
    org_number_col: mapping.org_number_col,
    supplier_type_col: mapping.supplier_type_col,
    email_col: mapping.email_col,
    phone_col: mapping.phone_col,
    address_line1_col: mapping.address_line1_col,
    address_line2_col: mapping.address_line2_col,
    postal_code_col: mapping.postal_code_col,
    city_col: mapping.city_col,
    country_col: mapping.country_col,
    vat_number_col: mapping.vat_number_col,
    bankgiro_col: mapping.bankgiro_col,
    plusgiro_col: mapping.plusgiro_col,
    bank_account_col: mapping.bank_account_col,
    iban_col: mapping.iban_col,
    bic_col: mapping.bic_col,
    payment_terms_col: mapping.payment_terms_col,
    default_currency_col: mapping.default_currency_col,
    notes_col: mapping.notes_col,
    confidence: 1,
  }
}

function legacyArticleOverrides(mapping: Mapping<DetectedArticleColumns>): DetectedArticleColumns {
  return {
    name_col: mapping.name_col ?? 0,
    article_number_col: mapping.article_number_col,
    name_en_col: mapping.name_en_col,
    type_col: mapping.type_col,
    unit_col: mapping.unit_col,
    price_col: mapping.price_col,
    currency_col: mapping.currency_col,
    vat_rate_col: mapping.vat_rate_col,
    revenue_account_col: mapping.revenue_account_col,
    cost_price_col: mapping.cost_price_col,
    ean_col: mapping.ean_col,
    housework_type_col: mapping.housework_type_col,
    notes_col: mapping.notes_col,
    confidence: 1,
  }
}

const CUSTOMER_KEYS = [
  'name_col', 'customer_number_col', 'org_number_col', 'customer_type_col', 'email_col', 'phone_col',
  'address_line1_col', 'address_line2_col', 'postal_code_col', 'city_col', 'country_col',
  'vat_number_col', 'payment_terms_col', 'notes_col',
] as const
const SUPPLIER_KEYS = [
  'name_col', 'org_number_col', 'supplier_type_col', 'email_col', 'phone_col', 'address_line1_col',
  'address_line2_col', 'postal_code_col', 'city_col', 'country_col', 'vat_number_col', 'bankgiro_col',
  'plusgiro_col', 'bank_account_col', 'iban_col', 'bic_col', 'payment_terms_col',
  'default_currency_col', 'notes_col',
] as const
const ARTICLE_KEYS = [
  'name_col', 'article_number_col', 'type_col', 'unit_col', 'price_col', 'currency_col', 'vat_rate_col',
  'revenue_account_col', 'cost_price_col', 'ean_col', 'housework_type_col', 'name_en_col', 'notes_col',
] as const

/** A mapping with every key set: odd keys mapped, even keys left empty, name unmapped or not. */
function sampleMapping<K extends string>(keys: readonly K[], nameMapped: boolean): Record<K, number | null> {
  const out = {} as Record<K, number | null>
  keys.forEach((k, i) => {
    out[k] = i % 2 === 1 ? i : null
  })
  ;(out as Record<string, number | null>).name_col = nameMapped ? 4 : null
  return out
}

describe('mappingToOverrides', () => {
  for (const nameMapped of [true, false]) {
    it(`matches the customer flow's overrides (name ${nameMapped ? 'mapped' : 'unmapped'})`, () => {
      const mapping = sampleMapping(CUSTOMER_KEYS, nameMapped)
      expect(mappingToOverrides(mapping)).toEqual(legacyCustomerOverrides(mapping))
    })
    it(`matches the supplier flow's overrides (name ${nameMapped ? 'mapped' : 'unmapped'})`, () => {
      const mapping = sampleMapping(SUPPLIER_KEYS, nameMapped)
      expect(mappingToOverrides(mapping)).toEqual(legacySupplierOverrides(mapping))
    })
    it(`matches the article flow's overrides (name ${nameMapped ? 'mapped' : 'unmapped'})`, () => {
      const mapping = sampleMapping(ARTICLE_KEYS, nameMapped)
      expect(mappingToOverrides(mapping)).toEqual(legacyArticleOverrides(mapping))
    })
  }
})

describe('columnsToMapping', () => {
  it('keeps numeric columns, nulls the rest and ignores keys outside the list', () => {
    expect(
      columnsToMapping({ name_col: 0, email_col: null, phone_col: 'x', confidence: 0.5 }, [
        'name_col',
        'email_col',
        'phone_col',
        'city_col',
      ]),
    ).toEqual({ name_col: 0, email_col: null, phone_col: null, city_col: null })
  })
})

describe('rowsForExecute', () => {
  const row = {
    row_index: 2,
    name: 'Acme',
    duplicate_match: null,
    is_valid: true,
    validation_errors: [],
    possible_duplicate: null,
    confirmed_duplicate_of: 'c1',
    vat_rate_adjusted: true,
  }

  it('drops what the customer and supplier flows dropped, and keeps the user\'s duplicate choice', () => {
    const { duplicate_match: _d, is_valid: _v, validation_errors: _ve, ...legacy } = row
    expect(rowsForExecute([row])).toEqual([legacy])
  })

  it('also drops vat_rate_adjusted for articles, as the article flow did', () => {
    const { duplicate_match: _d, is_valid: _v, validation_errors: _ve, vat_rate_adjusted: _vra, ...legacy } = row
    expect(rowsForExecute([row], ['vat_rate_adjusted'])).toEqual([legacy])
  })
})

describe('steps and endpoints', () => {
  it('asks for column mapping below 0.8 confidence only', () => {
    expect(needsColumnMapping({ confidence: 0.79 })).toBe(true)
    expect(needsColumnMapping({ confidence: 0.8 })).toBe(false)
  })

  it('shows the mapping step only when mapping is needed', () => {
    expect(registerSteps(true)).toEqual(['upload', 'column_mapping', 'edit', 'result'])
    expect(registerSteps(false)).toEqual(['upload', 'edit', 'result'])
  })

  it('posts to the register\'s own parse and execute routes', () => {
    expect(registerImportEndpoint('customers', 'parse')).toBe('/api/import/customers/parse')
    expect(registerImportEndpoint('suppliers', 'execute')).toBe('/api/import/suppliers/execute')
    expect(registerImportEndpoint('articles', 'parse')).toBe('/api/import/articles/parse')
  })
})

describe('countMatchedRows', () => {
  it('counts detected matches and rows the user confirmed as the same record', () => {
    expect(
      countMatchedRows([
        { duplicate_match: { id: 'x' } },
        { duplicate_match: null, confirmed_duplicate_of: 'c1' },
        { duplicate_match: null, confirmed_duplicate_of: null },
        { duplicate_match: null },
      ]),
    ).toBe(2)
  })
})
