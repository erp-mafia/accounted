/**
 * The arbetsgivaravgifter age tier (lib/salary/avgift-tier.ts) the salary
 * engine and the vacation year close share.
 */
import { describe, it, expect } from 'vitest'
import { avgiftAgeTier } from '../avgift-tier'

describe('avgiftAgeTier', () => {
  it('exempts a person born 1937 or earlier', () => {
    expect(avgiftAgeTier('193712310000', 2026, 67)).toBe('exempt')
  })

  it('reduces from the year the person has turned the reduced age at the year start', () => {
    // Born 1959: 66 at 1 January 2026, 67 at 1 January 2027.
    expect(avgiftAgeTier('195906150000', 2026, 67)).toBe('standard')
    expect(avgiftAgeTier('195906150000', 2027, 67)).toBe('reduced')
  })

  it('reads a malformed personnummer as standard', () => {
    expect(avgiftAgeTier('ÅÅÅÅMMDDNNNN', 2026, 67)).toBe('standard')
  })
})
