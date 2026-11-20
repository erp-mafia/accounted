import { describe, expect, it } from 'vitest'
import { identityText, maskForeignId } from '../people'
import type { RegisterParty } from '../types'

function party(partial: Partial<RegisterParty>): RegisterParty {
  return {
    party_id: 'p1',
    name: 'Namn',
    kind: 'person',
    org_number: null,
    personnummer_masked: null,
    foreign_id_masked: null,
    birth_date: null,
    address: null,
    email: null,
    ...partial,
  }
}

describe('maskForeignId', () => {
  it('shows the last four characters of a foreign identity number, and one of a short one', () => {
    expect(maskForeignId('DE123456789')).toBe('XXXXXXX6789')
    expect(maskForeignId(' AB12 ')).toBe('XXX2')
  })
})

describe('identityText (ABL 5:5 p. 2)', () => {
  it('prints a company by its organisationsnummer', () => {
    expect(identityText(party({ kind: 'company', org_number: '5560000001' }))).toBe('556000-0001')
  })

  it('prints a person by personnummer: full for an owner or admin, else masked', () => {
    const anna = party({ personnummer_masked: 'XXXXXXXX-1234' })
    expect(identityText(anna)).toBe('XXXXXXXX-1234')
    expect(identityText(anna, new Map([['p1', '19800101-1234']]))).toBe('19800101-1234')
  })

  it('prints the other identity number of a holder with neither a personnummer nor an organisationsnummer', () => {
    const hans = party({ foreign_id_masked: 'XXXXXXX6789', birth_date: '1970-05-05' })
    expect(identityText(hans)).toBe('XXXXXXX6789')
    expect(identityText(hans, new Map([['p1', 'DE123456789']]))).toBe('DE123456789')
    expect(identityText(party({ kind: 'company', foreign_id_masked: 'XXXXX4321' }), new Map([['p1', 'HRB 54321']]))).toBe('HRB 54321')
  })

  it('falls back to a birth date only when no number is on file', () => {
    expect(identityText(party({ birth_date: '1970-05-05' }))).toBe('1970-05-05')
    expect(identityText(party({ kind: 'company' }))).toBe('')
  })
})
