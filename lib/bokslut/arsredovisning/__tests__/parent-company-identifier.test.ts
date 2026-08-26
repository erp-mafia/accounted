import { describe, expect, it } from 'vitest'
import { isValidParentCompanyIdentifier } from '../parent-company-identifier'

describe('isValidParentCompanyIdentifier', () => {
  it('accepts Swedish organisationsnummer with and without the dash', () => {
    expect(isValidParentCompanyIdentifier('556677-8899')).toBe(true)
    expect(isValidParentCompanyIdentifier('5566778899')).toBe(true)
    expect(isValidParentCompanyIdentifier('16556677-8899')).toBe(true)
    expect(isValidParentCompanyIdentifier(' 559460-5627 ')).toBe(true)
  })

  it('rejects personnummer-shaped values in both 10- and 12-digit form', () => {
    expect(isValidParentCompanyIdentifier('850101-1234')).toBe(false)
    expect(isValidParentCompanyIdentifier('8501011234')).toBe(false)
    expect(isValidParentCompanyIdentifier('19850101-1234')).toBe(false)
    expect(isValidParentCompanyIdentifier('198501011234')).toBe(false)
    expect(isValidParentCompanyIdentifier('20120101-1234')).toBe(false)
  })

  it('accepts foreign registration identifiers as written in the home register', () => {
    expect(isValidParentCompanyIdentifier('CHE-123.456.789')).toBe(true)
    expect(isValidParentCompanyIdentifier('CHE-123.456.789 MWST')).toBe(true)
    expect(isValidParentCompanyIdentifier('923 609 016')).toBe(true)
    expect(isValidParentCompanyIdentifier('HRB 12345')).toBe(true)
    expect(isValidParentCompanyIdentifier('1234567-8')).toBe(true)
    expect(isValidParentCompanyIdentifier('12345678')).toBe(true)
    expect(isValidParentCompanyIdentifier('NL12345678')).toBe(true)
  })

  it('rejects empty, over-long and control-character values', () => {
    expect(isValidParentCompanyIdentifier('')).toBe(false)
    expect(isValidParentCompanyIdentifier('   ')).toBe(false)
    expect(isValidParentCompanyIdentifier('A'.repeat(41))).toBe(false)
    expect(isValidParentCompanyIdentifier('CHE-123<script>')).toBe(false)
    expect(isValidParentCompanyIdentifier('-123')).toBe(false)
  })
})
