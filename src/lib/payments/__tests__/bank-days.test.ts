import { describe, expect, it } from 'vitest'
import { nextBankDayIso } from '../bank-days'

describe('nextBankDayIso', () => {
  it('keeps a banking day and moves a weekend to Monday', () => {
    expect(nextBankDayIso('2026-10-09')).toBe('2026-10-09') // Friday
    expect(nextBankDayIso('2026-10-10')).toBe('2026-10-12') // Saturday
    expect(nextBankDayIso('2026-10-11')).toBe('2026-10-12') // Sunday
  })

  it('skips a Swedish holiday', () => {
    expect(nextBankDayIso('2027-01-01')).toBe('2027-01-04') // Nyårsdagen is a Friday
    expect(nextBankDayIso('2026-12-25')).toBe('2026-12-28') // Juldagen, then annandag jul and a weekend
  })
})
