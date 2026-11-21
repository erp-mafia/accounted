import { describe, expect, it } from 'vitest'
import { emptyAnswers, type FormationAnswers, quotaValue } from '../answers'
import { beneficialOwners, checkAnswers, checkDescription, isValidOrgNumber } from '../rules'

// Published Skatteverket test personnummer (open-data list).
const PNR_A = '195001182046'
const PNR_B = '201212121212'

function solo(overrides: Partial<FormationAnswers> = {}): FormationAnswers {
  return {
    ...emptyAnswers(),
    names: ['Testbolaget Nord AB', 'Nordtest AB'],
    description: 'konsultverksamhet inom systemutveckling och drift av webbtjänster',
    seat: 'Stockholm',
    address: { co: '', street: 'Testgatan 1', postalCode: '11122', city: 'Stockholm' },
    contact: { name: 'Test Testsson', email: 'test@example.se', phone: '+46701234567' },
    bank: 'svea',
    parties: [
      { id: 'a', type: 'person', name: 'Test Testsson', personnummer: PNR_A, email: '', shares: 500, roles: ['ledamot'] },
      { id: 'b', type: 'person', name: 'Deputy Person', personnummer: PNR_B, email: '', shares: 0, roles: ['suppleant'] },
    ],
    ...overrides,
  }
}

const codes = (a: FormationAnswers) => checkAnswers(a).filter((i) => i.severity === 'error').map((i) => i.code)

describe('checkAnswers', () => {
  it('passes a complete solo formation with a deputy', () => {
    expect(codes(solo())).toEqual([])
  })

  it('requires a deputy when the board has fewer than three members', () => {
    const a = solo()
    a.parties = a.parties.filter((p) => p.id !== 'b')
    expect(codes(a)).toContain('deputy_required')
  })

  it('refuses a chair on a one-member board', () => {
    const a = solo()
    a.parties[0] = { ...a.parties[0], roles: ['ledamot', 'ordforande'] } as FormationAnswers['parties'][number]
    expect(codes(a)).toContain('chair_needs_two_members')
  })

  it('needs AB or aktiebolag in every name proposal', () => {
    expect(codes(solo({ names: ['Testbolaget Nord'] }))).toContain('name_needs_ab')
    expect(codes(solo({ names: ['Testbolaget Nord Aktiebolag'] }))).not.toContain('name_needs_ab')
  })

  it('checks that the subscribed shares add up to the share count', () => {
    const a = solo({ capital: { amount: 25_000, shares: 1000 } })
    expect(codes(a)).toContain('shares_do_not_add_up')
  })

  it('refuses share capital under 25,000 kr', () => {
    expect(codes(solo({ capital: { amount: 20_000, shares: 500 } }))).toContain('capital_below_minimum')
  })

  it('validates personnummer with the Luhn check', () => {
    const a = solo()
    a.parties[1] = { ...a.parties[1], personnummer: '195001182047' } as FormationAnswers['parties'][number]
    expect(codes(a)).toContain('personnummer_invalid')
  })

  it('asks who controls a founding company that owns more than 25 percent', () => {
    const a = solo()
    a.parties[0] = { ...a.parties[0], shares: 250 } as FormationAnswers['parties'][number]
    a.parties.push({ id: 'c', type: 'company', name: 'Holding AB', orgNumber: '5595386219', signatories: ['Test Testsson'], shares: 250, controlledBy: [] })
    expect(codes(a)).toContain('company_controller_missing')
  })
})

describe('checkDescription', () => {
  it('refuses bl.a., m.m. and etc.', () => {
    expect(checkDescription('försäljning av kläder, skor m.m.').map((d) => d.code)).toContain('description_forbidden_words')
    expect(checkDescription('handel med bl.a. kläder').map((d) => d.code)).toContain('description_forbidden_words')
  })
  it('refuses a bare "handel" or "konsultverksamhet"', () => {
    expect(checkDescription('konsultverksamhet').map((d) => d.code)).toContain('description_vague')
    expect(checkDescription('Handel.').map((d) => d.code)).toContain('description_vague')
  })
  it('refuses SNI codes', () => {
    expect(checkDescription('verksamhet enligt SNI 62010 och därmed förenlig verksamhet').map((d) => d.code)).toContain('description_sni_code')
  })
  it('accepts a concrete description', () => {
    expect(checkDescription('försäljning av begagnade cyklar och reservdelar via webbutik')).toEqual([])
  })
})

describe('beneficialOwners', () => {
  it('lists everyone above 25 percent and nobody at exactly 25', () => {
    const a = solo()
    a.parties = [
      { id: 'a', type: 'person', name: 'A', personnummer: PNR_A, email: '', shares: 300, roles: ['ledamot'] },
      { id: 'b', type: 'person', name: 'B', personnummer: PNR_B, email: '', shares: 200, roles: ['suppleant'] },
    ]
    expect(beneficialOwners(a)).toEqual([
      { name: 'A', percent: 60, via: 'direct' },
      { name: 'B', percent: 40, via: 'direct' },
    ])
    a.parties = ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'person' as const, name: id, personnummer: '', email: '', shares: 125, roles: [] }))
    expect(beneficialOwners(a)).toEqual([])
  })
  it('looks through a founding company to the people who control it', () => {
    const a = solo()
    a.parties = [{ id: 'c', type: 'company', name: 'Holding AB', orgNumber: '5595386219', signatories: ['X'], shares: 500, controlledBy: ['Owner One'] }]
    expect(beneficialOwners(a)).toEqual([{ name: 'Owner One', percent: 100, via: 'indirect', throughCompany: 'Holding AB' }])
  })
})

describe('helpers', () => {
  it('computes the quota value', () => {
    expect(quotaValue(solo())).toBe(50)
  })
  it('validates organisation numbers', () => {
    expect(isValidOrgNumber('559538-6219')).toBe(true)
    expect(isValidOrgNumber('559538-6218')).toBe(false)
  })
})
