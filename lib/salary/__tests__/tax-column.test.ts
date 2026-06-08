import { describe, it, expect } from 'vitest'
import { deriveTaxColumn, getTaxColumnOption, TAX_COLUMN_OPTIONS } from '../tax-column'

describe('deriveTaxColumn', () => {
  it('returns column 1 for an employee comfortably under 66', () => {
    // Born 1990 → 36 in 2026
    expect(deriveTaxColumn('199003151234', 2026)).toBe(1)
  })

  it('returns column 1 at the exact under-66 boundary (born 1960 for 2026)', () => {
    // "född 1960 eller senare" = kolumn 1 för inkomståret 2026
    expect(deriveTaxColumn('196006151234', 2026)).toBe(1)
  })

  it('returns null (manual) for the 66+ group (born 1959 for 2026)', () => {
    // Column 2 (pension) vs 3 (working senior) can't be inferred from age.
    expect(deriveTaxColumn('195906151234', 2026)).toBeNull()
  })

  it('returns null for a clearly senior employee', () => {
    expect(deriveTaxColumn('194001011234', 2026)).toBeNull()
  })

  it('tracks the boundary with the income year', () => {
    // Born 1959: under-66 group for 2025 (year - 66 = 1959), 66+ group for 2026.
    expect(deriveTaxColumn('195906151234', 2025)).toBe(1)
    expect(deriveTaxColumn('195906151234', 2026)).toBeNull()
  })

  it('works from a masked personnummer (YYYYMMDD-XXXX)', () => {
    expect(deriveTaxColumn('19900315-XXXX', 2026)).toBe(1)
  })

  it('returns null when there is not enough of a birthdate to decide', () => {
    expect(deriveTaxColumn('', 2026)).toBeNull()
    expect(deriveTaxColumn('1990', 2026)).toBeNull()
    expect(deriveTaxColumn('199003', 2026)).toBeNull()
  })

  it('returns null for an implausible birth year', () => {
    expect(deriveTaxColumn('180003151234', 2026)).toBeNull()
    // birth year after the income year
    expect(deriveTaxColumn('203003151234', 2026)).toBeNull()
  })
})

describe('TAX_COLUMN_OPTIONS', () => {
  it('covers all six Skatteverket columns in order', () => {
    expect(TAX_COLUMN_OPTIONS.map((o) => o.value)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('looks up an option by value', () => {
    expect(getTaxColumnOption(1)?.label).toContain('under 66')
    expect(getTaxColumnOption(3)?.label).toContain('66+')
    expect(getTaxColumnOption(99)).toBeUndefined()
  })
})
