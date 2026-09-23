import { describe, it, expect } from 'vitest'
import { buildPersonProperties, buildGroupProperties } from '../properties'

describe('buildPersonProperties', () => {
  it('carries email, name and role', () => {
    expect(
      buildPersonProperties({
        userId: 'u1',
        email: 'jakob@example.se',
        fullName: 'Jakob Wennberg',
        role: 'owner',
      })
    ).toEqual({ email: 'jakob@example.se', name: 'Jakob Wennberg', role: 'owner' })
  })

  it('omits missing fields instead of sending nulls', () => {
    expect(buildPersonProperties({ userId: 'u1', email: null, fullName: undefined })).toEqual({})
  })

  it('never echoes the userId into properties (it is the distinct id)', () => {
    const props = buildPersonProperties({ userId: 'u1', email: 'a@b.se' })
    expect(props).not.toHaveProperty('userId')
    expect(props).not.toHaveProperty('user_id')
  })
})

describe('buildGroupProperties', () => {
  const company = {
    id: 'c1',
    name: 'Nordvik Bygg AB',
    entityType: 'aktiebolag' as const,
    accountingFramework: 'k2' as const,
    paysSalaries: true,
    trialEndsAt: '2026-08-01',
    capabilities: ['ai', 'salary'],
  }

  it('carries company-shaped facts', () => {
    expect(buildGroupProperties(company)).toEqual({
      name: 'Nordvik Bygg AB',
      entity_type: 'aktiebolag',
      accounting_framework: 'k2',
      pays_salaries: true,
      trial_ends_at: '2026-08-01',
      capabilities: ['ai', 'salary'],
    })
  })

  // The load-bearing privacy assertion: for an enskild firma the
  // organisationsnummer IS the owner's personnummer.
  it('never sends org_number, whatever is passed in', () => {
    const props = buildGroupProperties({
      ...company,
      // @ts-expect-error deliberately passing a field the type forbids
      org_number: '556677-8899',
      orgNumber: '556677-8899',
    })
    expect(props).not.toHaveProperty('org_number')
    expect(props).not.toHaveProperty('orgNumber')
    expect(JSON.stringify(props)).not.toContain('556677')
  })

  it('sorts capabilities so ordering churn is not seen as a change', () => {
    const a = buildGroupProperties({ ...company, capabilities: ['salary', 'ai'] })
    const b = buildGroupProperties({ ...company, capabilities: ['ai', 'salary'] })
    expect(a.capabilities).toEqual(b.capabilities)
  })

  it('does not mutate the caller capabilities array', () => {
    const capabilities = ['salary', 'ai']
    buildGroupProperties({ ...company, capabilities })
    expect(capabilities).toEqual(['salary', 'ai'])
  })

  it('omits absent optional fields', () => {
    expect(buildGroupProperties({ id: 'c1', name: 'Ensam EF' })).toEqual({ name: 'Ensam EF' })
  })
})
