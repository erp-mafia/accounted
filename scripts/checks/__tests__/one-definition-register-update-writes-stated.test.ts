/**
 * The register update guard catches the merge that wrote the parser's
 * fill-ins and a type decision written by hand, and leaves the merge that
 * writes what the row states.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/register-update-writes-stated.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('register-update-writes-stated', () => {
  it.each([
    'if (row.supplier_type) merged.supplier_type = row.supplier_type',
    'if (row.customer_type) merged.customer_type = row.customer_type',
    'if (row.country) merged.country = row.country',
    'if (row.default_currency) merged.default_currency = row.default_currency',
    'if (row.supplier_type) {',
    'if (row.country) patch.country = row.country',
    "|| (row.customer_type_stated === 'business' && customer.customer_type === 'individual')",
    "customer_type_stated: anyBusiness ? 'business' : explicitType !== null ? 'type' : null,",
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'if (typeAndCountryWrite.type !== undefined) merged.supplier_type = typeAndCountryWrite.type',
    'if (row.country_stated) merged.country = row.country',
    'if (row.default_currency_stated) merged.default_currency = row.default_currency',
    'if (row.vat_number) merged.vat_number = row.vat_number',
    "const typeNamed = row.customer_type_stated === 'type'",
    'supplier_type_stated: statedType(saysOnlyCompany(typeRaw), explicitType !== null),',
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
