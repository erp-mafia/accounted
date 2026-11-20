import { describe, it, expect } from 'vitest'
import { daysUntilDeadline } from '../status-engine'

describe('daysUntilDeadline', () => {
  it('counts calendar days across the autumn DST change (2026-10-25)', () => {
    const now = new Date('2026-10-12T08:00:00Z')
    expect(daysUntilDeadline('2026-10-26', now)).toBe(14)
    expect(daysUntilDeadline('2026-10-27', now)).toBe(15)
  })

  it('counts calendar days across the spring DST change (2026-03-29)', () => {
    const now = new Date('2026-03-20T08:00:00Z')
    expect(daysUntilDeadline('2026-04-03', now)).toBe(14)
  })

  it('uses the Swedish calendar day: 23:30 UTC on the 11th is already the 12th in Stockholm', () => {
    const now = new Date('2026-10-11T23:30:00Z')
    expect(daysUntilDeadline('2026-10-12', now)).toBe(0)
    expect(daysUntilDeadline('2026-10-11', now)).toBe(-1)
  })

  it('accepts a timestamp-shaped due date by its date part', () => {
    const now = new Date('2026-10-12T08:00:00Z')
    expect(daysUntilDeadline('2026-10-19T00:00:00Z', now)).toBe(7)
  })
})
