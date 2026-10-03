import { describe, it, expect } from 'vitest'
import { CSV_DATA_ENTITIES, parseCsvDataEntity, registerImportHref } from '../register-import-link'

describe('register import deep link', () => {
  it('opens the CSV/Excel wizard on the register it was built for', () => {
    expect(registerImportHref('customers')).toBe('/import?mode=csv_data&entity=customers')
    expect(registerImportHref('suppliers')).toBe('/import?mode=csv_data&entity=suppliers')
    expect(registerImportHref('articles')).toBe('/import?mode=csv_data&entity=articles')
  })

  it('round-trips: the import page reads back what a list page built', () => {
    for (const entity of ['customers', 'suppliers', 'articles'] as const) {
      const params = new URL(registerImportHref(entity), 'https://example.test').searchParams
      expect(params.get('mode')).toBe('csv_data')
      expect(parseCsvDataEntity(params.get('entity'))).toBe(entity)
    }
  })

  it('accepts every wizard tab, including opening balances', () => {
    for (const entity of CSV_DATA_ENTITIES) {
      expect(parseCsvDataEntity(entity)).toBe(entity)
    }
  })

  it('returns null for a missing or unknown value', () => {
    expect(parseCsvDataEntity(null)).toBeNull()
    expect(parseCsvDataEntity(undefined)).toBeNull()
    expect(parseCsvDataEntity('')).toBeNull()
    expect(parseCsvDataEntity('employees')).toBeNull()
    expect(parseCsvDataEntity('Customers')).toBeNull()
  })
})
