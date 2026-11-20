import { describe, expect, it } from 'vitest'
import { commitmentsEnabledFor, commitmentsRollout, commitmentsRolloutConfigured } from '../commitments-switch'

const A = 'AAAAAAAA-0000-4000-8000-000000000001'

describe('commitments switch (BOLAGET_COMPANY_IDS)', () => {
  it('is off for everybody while unset or blank', () => {
    expect(commitmentsRollout({})).toEqual([])
    expect(commitmentsEnabledFor(A, { BOLAGET_COMPANY_IDS: '  ' })).toBe(false)
    expect(commitmentsRolloutConfigured({})).toBe(false)
  })

  it('opens for the listed companies only, whatever the case', () => {
    const env = { BOLAGET_COMPANY_IDS: `${A.toLowerCase()}, other` }
    expect(commitmentsEnabledFor(A, env)).toBe(true)
    expect(commitmentsEnabledFor('third', env)).toBe(false)
    expect(commitmentsEnabledFor(null, env)).toBe(false)
    expect(commitmentsRolloutConfigured(env)).toBe(true)
  })

  it('opens for everyone with *', () => {
    expect(commitmentsEnabledFor(A, { BOLAGET_COMPANY_IDS: '*' })).toBe(true)
    expect(commitmentsRollout({ BOLAGET_COMPANY_IDS: '*' })).toBe('all')
  })
})
