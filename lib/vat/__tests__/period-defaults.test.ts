import { describe, it, expect } from 'vitest'
import { mostRecentEndedVatPeriod } from '../period-defaults'

describe('mostRecentEndedVatPeriod', () => {
  describe('monthly', () => {
    it('returns the previous month mid-year', () => {
      expect(mostRecentEndedVatPeriod('monthly', new Date('2026-08-06'))).toEqual({
        year: 2026,
        period: 7,
      })
    })

    it('rolls back to December of the previous year in January', () => {
      expect(mostRecentEndedVatPeriod('monthly', new Date('2026-01-15'))).toEqual({
        year: 2025,
        period: 12,
      })
    })

    it('returns January in February', () => {
      expect(mostRecentEndedVatPeriod('monthly', new Date('2026-02-01'))).toEqual({
        year: 2026,
        period: 1,
      })
    })
  })

  describe('quarterly', () => {
    it('returns the previous quarter mid-year', () => {
      expect(mostRecentEndedVatPeriod('quarterly', new Date('2026-08-06'))).toEqual({
        year: 2026,
        period: 2,
      })
    })

    it('rolls back to Q4 of the previous year during Q1', () => {
      expect(mostRecentEndedVatPeriod('quarterly', new Date('2026-02-28'))).toEqual({
        year: 2025,
        period: 4,
      })
    })

    it('returns Q1 at the start of Q2', () => {
      expect(mostRecentEndedVatPeriod('quarterly', new Date('2026-04-01'))).toEqual({
        year: 2026,
        period: 1,
      })
    })

    it('returns Q3 in December', () => {
      expect(mostRecentEndedVatPeriod('quarterly', new Date('2026-12-31'))).toEqual({
        year: 2026,
        period: 3,
      })
    })
  })
})
