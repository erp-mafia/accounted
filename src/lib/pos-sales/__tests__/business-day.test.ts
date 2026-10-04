import { describe, expect, it } from 'vitest'
import { datesBetween, latestClosedBusinessDay, nextMorningRun } from '../business-day'

describe('latestClosedBusinessDay', () => {
  it('is yesterday from 06:00 Swedish time, the day before before that (summer time)', () => {
    // 2026-10-01 05:59 CEST = 03:59Z; 06:00 CEST = 04:00Z.
    expect(latestClosedBusinessDay(new Date('2026-10-01T03:59:00Z'))).toBe('2026-09-29')
    expect(latestClosedBusinessDay(new Date('2026-10-01T04:00:00Z'))).toBe('2026-09-30')
  })

  it('follows the Swedish clock in winter time too', () => {
    // 2026-12-01 06:00 CET = 05:00Z.
    expect(latestClosedBusinessDay(new Date('2026-12-01T04:59:00Z'))).toBe('2026-11-29')
    expect(latestClosedBusinessDay(new Date('2026-12-01T05:00:00Z'))).toBe('2026-11-30')
  })

  it('uses the Swedish date just after midnight, not the UTC one', () => {
    // 00:30 CEST on 2026-10-02 is still 2026-10-01 in UTC.
    expect(latestClosedBusinessDay(new Date('2026-10-01T22:30:00Z'))).toBe('2026-09-30')
  })
})

describe('nextMorningRun', () => {
  it('is 06:15 Swedish time today when that is still ahead, else tomorrow', () => {
    expect(nextMorningRun(new Date('2026-10-01T03:00:00Z')).toISOString()).toBe('2026-10-01T04:15:00.000Z')
    expect(nextMorningRun(new Date('2026-10-01T04:15:00Z')).toISOString()).toBe('2026-10-02T04:15:00.000Z')
  })

  it('crosses the switch to winter time on the right instant', () => {
    // Summer time ends 2026-10-25 03:00 CEST -> 02:00 CET.
    expect(nextMorningRun(new Date('2026-10-24T10:00:00Z')).toISOString()).toBe('2026-10-25T05:15:00.000Z')
  })
})

describe('datesBetween', () => {
  it('lists every date inclusive, across a month end, and nothing for a reversed range', () => {
    expect(datesBetween('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'])
    expect(datesBetween('2026-10-02', '2026-09-29')).toEqual([])
    expect(datesBetween('2026-01-01', '2026-12-31', 3)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03'])
  })
})
