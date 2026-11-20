import { describe, expect, it } from 'vitest'
import { existingCompanyMatch, isSoleTraderMatch, shouldGateDuplicate, type ExistingCompanyMatch } from '../duplicate-gate'

const match: ExistingCompanyMatch = {
  orgNumber: '5588990019',
  companies: [{ id: 'c1', name: 'Dubblettbolaget AB', role: 'owner', createdAt: '2026-01-10T09:00:00+00:00' }],
}

describe('existingCompanyMatch', () => {
  it('keeps every company the check answered, oldest first', () => {
    const result = existingCompanyMatch('5588990019', [
      { id: 'c-new', name: 'Dubblettbolaget AB', role: 'admin', created_at: '2026-10-02T14:05:00+00:00' },
      { id: 'c-old', name: 'Dubblettbolaget AB', role: 'owner', created_at: '2025-01-15T08:00:00+00:00' },
    ])
    expect(result).toEqual({
      orgNumber: '5588990019',
      companies: [
        { id: 'c-old', name: 'Dubblettbolaget AB', role: 'owner', createdAt: '2025-01-15T08:00:00+00:00' },
        { id: 'c-new', name: 'Dubblettbolaget AB', role: 'admin', createdAt: '2026-10-02T14:05:00+00:00' },
      ],
    })
  })

  it('reads an answer without role or created time (an older server) as one company', () => {
    expect(existingCompanyMatch('5588990019', [{ id: 'c1', name: 'Dubblettbolaget AB' }])).toEqual({
      orgNumber: '5588990019',
      companies: [{ id: 'c1', name: 'Dubblettbolaget AB', role: '', createdAt: null }],
    })
  })

  it('is null when the answer names no company', () => {
    expect(existingCompanyMatch('5588990019', [])).toBeNull()
    expect(existingCompanyMatch('5588990019', undefined)).toBeNull()
    expect(existingCompanyMatch('5588990019', [{ name: 'no id' }, null, 'x'])).toBeNull()
  })
})

describe('shouldGateDuplicate', () => {
  it('gates the step after the orgnr when the user already has the company', () => {
    expect(
      shouldGateDuplicate({ match, orgNumber: '558899-0019', acknowledgedOrgNumber: null, step: 'fy' }),
    ).toBe(true)
  })

  it('does not gate without a match', () => {
    expect(
      shouldGateDuplicate({ match: null, orgNumber: '5588990019', acknowledgedOrgNumber: null, step: 'fy' }),
    ).toBe(false)
  })

  it('does not gate once the user chose a separate copy for this org number', () => {
    expect(
      shouldGateDuplicate({ match, orgNumber: '5588990019', acknowledgedOrgNumber: '5588990019', step: 'moms' }),
    ).toBe(false)
  })

  it('gates again when the acknowledgement was for another org number', () => {
    expect(
      shouldGateDuplicate({ match, orgNumber: '5588990019', acknowledgedOrgNumber: '5561234567', step: 'fy' }),
    ).toBe(true)
  })

  it('does not gate when the journey moved on to a different org number', () => {
    expect(
      shouldGateDuplicate({ match, orgNumber: '5561234567', acknowledgedOrgNumber: null, step: 'fy' }),
    ).toBe(false)
  })

  it('does not gate on the orgnr step or after creation', () => {
    expect(shouldGateDuplicate({ match, orgNumber: '5588990019', acknowledgedOrgNumber: null, step: 'orgnr' })).toBe(false)
    expect(shouldGateDuplicate({ match, orgNumber: '5588990019', acknowledgedOrgNumber: null, step: 'done' })).toBe(false)
  })

  it('accepts the 12-digit form of the same org number', () => {
    expect(
      shouldGateDuplicate({ match, orgNumber: '165588990019', acknowledgedOrgNumber: null, step: 'name' }),
    ).toBe(true)
  })
})

describe('isSoleTraderMatch', () => {
  it('is true for a firm whose org number is a personnummer (PH 216)', () => {
    // A Luhn-valid test personnummer (month 12 < 20: a natural person).
    expect(isSoleTraderMatch({ ...match, orgNumber: '1212121212' })).toBe(true)
  })

  it('is false for a juridisk person', () => {
    expect(isSoleTraderMatch(match)).toBe(false)
  })
})
