import { describe, expect, it } from 'vitest'
import { shortDate, shortDateTime } from '../dates'

const NOW = new Date('2026-10-17T08:00:00Z')

describe('shortDate', () => {
  it('writes a date this year without the year', () => {
    expect(shortDate('2026-10-03', 'sv', NOW)).toBe('3 okt.')
    expect(shortDate('2026-05-31', 'sv', NOW)).toBe('31 maj')
    expect(shortDate('2026-10-03', 'en', NOW)).toBe('Oct 3')
  })

  it('adds the year when it is not this year', () => {
    expect(shortDate('2025-12-30', 'sv', NOW)).toBe('30 dec. 2025')
    expect(shortDate('2027-01-02', 'en', NOW)).toBe('Jan 2, 2027')
  })

  it('reads a calendar date as that day, whatever the zone', () => {
    expect(shortDate('2026-01-01', 'sv', NOW)).toBe('1 jan.')
  })

  it('reads a moment in Stockholm: late on New Year\'s Eve UTC is already next year there', () => {
    expect(shortDate('2026-12-31T23:30:00Z', 'sv', NOW)).toBe('1 jan. 2027')
    expect(shortDate('2026-10-02T22:30:00Z', 'sv', NOW)).toBe('3 okt.')
  })

  it('leaves something that is not a date as it is', () => {
    expect(shortDate('snart', 'sv', NOW)).toBe('snart')
  })
})

describe('shortDateTime', () => {
  it('adds the time in Stockholm to a moment', () => {
    expect(shortDateTime('2026-10-03T12:31:00Z', 'sv', NOW)).toBe('3 okt. 14:31')
    expect(shortDateTime('2026-01-15T08:05:00Z', 'sv', NOW)).toBe('15 jan. 09:05')
  })

  it('prints a bare calendar date without a time', () => {
    expect(shortDateTime('2026-10-03', 'sv', NOW)).toBe('3 okt.')
  })
})
