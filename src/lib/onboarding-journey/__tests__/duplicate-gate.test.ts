import { describe, expect, it } from 'vitest'
import { isSoleTraderMatch, shouldGateDuplicate, type ExistingCompanyMatch } from '../duplicate-gate'

const match: ExistingCompanyMatch = { orgNumber: '5588990019', companyId: 'c1', name: 'Dubblettbolaget AB' }

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
    expect(isSoleTraderMatch({ orgNumber: '1212121212', companyId: 'c2', name: 'Firma' })).toBe(true)
  })

  it('is false for a juridisk person', () => {
    expect(isSoleTraderMatch(match)).toBe(false)
  })
})
