import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../owner-tax/k10-parameters', () => ({ supportedK10Years: vi.fn() }))

import { incomeYearToFile, ownerTaxOpeningYear } from '../filing-year'
import { supportedK10Years } from '../../owner-tax/k10-parameters'

const supported = vi.mocked(supportedK10Years)

beforeEach(() => {
  vi.clearAllMocks()
  supported.mockReturnValue([2026])
})

describe('incomeYearToFile', () => {
  it('is last year through January, while KU31 and KU20 for it are due', () => {
    expect(incomeYearToFile('2027-01-01')).toBe(2026)
    expect(incomeYearToFile('2027-01-31')).toBe(2026)
  })

  it('is this year from February to December', () => {
    expect(incomeYearToFile('2027-02-01')).toBe(2027)
    expect(incomeYearToFile('2026-12-31')).toBe(2026)
  })
})

describe('ownerTaxOpeningYear', () => {
  it('opens on last year in January', () => {
    supported.mockReturnValue([2026, 2027])
    expect(ownerTaxOpeningYear('2027-01-15')).toBe(2026)
  })

  it('opens on the year to file when it has K10 underlag', () => {
    expect(ownerTaxOpeningYear('2026-06-01')).toBe(2026)
    supported.mockReturnValue([2026, 2027])
    expect(ownerTaxOpeningYear('2027-03-01')).toBe(2027)
  })

  it('never opens on a year without underlag when an earlier year has one', () => {
    // 2027's inkomstbasbelopp and statslåneränta not in Accounted yet.
    expect(ownerTaxOpeningYear('2027-03-01')).toBe(2026)
    // The latest earlier year with underlag, not the first.
    supported.mockReturnValue([2026, 2027])
    expect(ownerTaxOpeningYear('2029-05-02')).toBe(2027)
  })

  it('stays on the year to file when no earlier year has underlag', () => {
    expect(ownerTaxOpeningYear('2026-01-20')).toBe(2025)
  })
})
