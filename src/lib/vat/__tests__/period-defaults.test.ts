import { describe, it, expect } from 'vitest'
import { mostRecentEndedVatPeriod } from '../period-defaults'

// Dates use the local-time Date(y, m, d) constructor: the ISO-string form
// parses as UTC midnight, which shifts a calendar day in negative-offset
// timezones and would break the deadline-boundary assertions there.

describe('mostRecentEndedVatPeriod', () => {
  describe('monthly (standard filers: month M due the 12th/17th of M+2)', () => {
    it('returns M-2 while the deadline for it is still open', () => {
      // 2026-08-06: June's declaration is due 17 Aug (August deadline day).
      expect(mostRecentEndedVatPeriod('monthly', new Date(2026, 7, 6))).toEqual({
        year: 2026,
        period: 6,
      })
    })

    it('advances to M-1 once the deadline has passed', () => {
      // 2026-08-20: June is filed; July (due 12 Sep) is the open one.
      expect(mostRecentEndedVatPeriod('monthly', new Date(2026, 7, 20))).toEqual({
        year: 2026,
        period: 7,
      })
    })

    it('uses the 12th as deadline day outside January and August', () => {
      expect(mostRecentEndedVatPeriod('monthly', new Date(2026, 2, 12))).toEqual({
        year: 2026,
        period: 1,
      })
      expect(mostRecentEndedVatPeriod('monthly', new Date(2026, 2, 13))).toEqual({
        year: 2026,
        period: 2,
      })
    })

    it('rolls back across the year boundary in January', () => {
      // 2026-01-10: November 2025 is due 17 Jan (January deadline day).
      expect(mostRecentEndedVatPeriod('monthly', new Date(2026, 0, 10))).toEqual({
        year: 2025,
        period: 11,
      })
      // After the January deadline: December 2025 is the open one.
      expect(mostRecentEndedVatPeriod('monthly', new Date(2026, 0, 20))).toEqual({
        year: 2025,
        period: 12,
      })
    })

    it('keeps the M-2 period through an adjusted banking-day deadline', () => {
      // 17 January 2026 is Saturday, so the deadline moves to Monday 19th.
      expect(mostRecentEndedVatPeriod('monthly', new Date(2026, 0, 19))).toEqual({
        year: 2025,
        period: 11,
      })
      expect(mostRecentEndedVatPeriod('monthly', new Date(2026, 0, 20))).toEqual({
        year: 2025,
        period: 12,
      })
    })

    it('over-40M filers (month M due the 26th of M+1) always get M-1', () => {
      expect(
        mostRecentEndedVatPeriod('monthly', new Date(2026, 7, 6), { over40m: true }),
      ).toEqual({ year: 2026, period: 7 })
      expect(
        mostRecentEndedVatPeriod('monthly', new Date(2026, 0, 10), { over40m: true }),
      ).toEqual({ year: 2025, period: 12 })
    })
  })

  describe('quarterly', () => {
    it('returns the previous quarter mid-year', () => {
      expect(mostRecentEndedVatPeriod('quarterly', new Date(2026, 7, 6))).toEqual({
        year: 2026,
        period: 2,
      })
    })

    it('rolls back to Q4 of the previous year during Q1', () => {
      expect(mostRecentEndedVatPeriod('quarterly', new Date(2026, 1, 28))).toEqual({
        year: 2025,
        period: 4,
      })
    })

    it('returns Q1 at the start of Q2', () => {
      expect(mostRecentEndedVatPeriod('quarterly', new Date(2026, 3, 1))).toEqual({
        year: 2026,
        period: 1,
      })
    })

    it('returns Q3 in December', () => {
      expect(mostRecentEndedVatPeriod('quarterly', new Date(2026, 11, 31))).toEqual({
        year: 2026,
        period: 3,
      })
    })
  })
})
