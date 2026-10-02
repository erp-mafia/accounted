import { describe, expect, it } from 'vitest'
import { shouldGateDuplicate, type ExistingCompanyMatch } from '../duplicate-gate'

const match: ExistingCompanyMatch = { orgNumber: '5593974149', companyId: 'c1', name: 'ISolution AB' }

describe('shouldGateDuplicate', () => {
  it('gates the step after the orgnr when the user already has the company', () => {
    expect(
      shouldGateDuplicate({ match, orgNumber: '559397-4149', acknowledgedOrgNumber: null, step: 'fy' }),
    ).toBe(true)
  })

  it('does not gate without a match', () => {
    expect(
      shouldGateDuplicate({ match: null, orgNumber: '5593974149', acknowledgedOrgNumber: null, step: 'fy' }),
    ).toBe(false)
  })

  it('does not gate once the user chose a separate copy for this org number', () => {
    expect(
      shouldGateDuplicate({ match, orgNumber: '5593974149', acknowledgedOrgNumber: '5593974149', step: 'moms' }),
    ).toBe(false)
  })

  it('gates again when the acknowledgement was for another org number', () => {
    expect(
      shouldGateDuplicate({ match, orgNumber: '5593974149', acknowledgedOrgNumber: '5561234567', step: 'fy' }),
    ).toBe(true)
  })

  it('does not gate when the journey moved on to a different org number', () => {
    expect(
      shouldGateDuplicate({ match, orgNumber: '5561234567', acknowledgedOrgNumber: null, step: 'fy' }),
    ).toBe(false)
  })

  it('does not gate on the orgnr step or after creation', () => {
    expect(shouldGateDuplicate({ match, orgNumber: '5593974149', acknowledgedOrgNumber: null, step: 'orgnr' })).toBe(false)
    expect(shouldGateDuplicate({ match, orgNumber: '5593974149', acknowledgedOrgNumber: null, step: 'done' })).toBe(false)
  })

  it('accepts the 12-digit form of the same org number', () => {
    expect(
      shouldGateDuplicate({ match, orgNumber: '165593974149', acknowledgedOrgNumber: null, step: 'name' }),
    ).toBe(true)
  })
})
