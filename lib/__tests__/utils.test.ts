import { describe, it, expect } from 'vitest'
import { swedishToday } from '../utils'

describe('swedishToday', () => {
  it('formats the date as ISO yyyy-MM-dd with a Swedish weekday', () => {
    // 2026-01-01 is a Thursday → "torsdag". Noon UTC keeps us clear of any
    // midnight boundary so the assertion is timezone-stable.
    expect(swedishToday(new Date('2026-01-01T12:00:00Z'))).toBe('2026-01-01 (torsdag)')
  })

  it('reports the date in Europe/Stockholm, not UTC', () => {
    // 23:30 UTC on 2026-05-26 is already 01:30 on 2026-05-27 in Stockholm
    // (CEST, UTC+2). A naive UTC date would read the day before — the off-by-one
    // we explicitly format around for users near midnight.
    expect(swedishToday(new Date('2026-05-26T23:30:00Z'))).toBe('2026-05-27 (onsdag)')
  })

  it('omits clock time so the cached prompt prefix stays stable across a day', () => {
    const morning = swedishToday(new Date('2026-05-27T06:00:00Z'))
    const evening = swedishToday(new Date('2026-05-27T18:00:00Z'))
    expect(morning).toBe(evening)
    expect(morning).not.toMatch(/\d{2}:\d{2}/)
  })
})
