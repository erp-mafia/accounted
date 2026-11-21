import { describe, expect, it } from 'vitest'
import { emptyAnswers, type FormationAnswers } from '../answers'
import { openAnswers, publicAnswers, sealAnswers } from '../store'
import { firstFiscalYear } from '../fiscal-year'
import { checkSetupInput } from '../setup'
import type { FormationRow } from '../store'

// Published Skatteverket test personnummer.
const PNR = '195001182046'

function withPerson(personnummer: string): FormationAnswers {
  return {
    ...emptyAnswers(),
    parties: [{ id: 'a', type: 'person', name: 'Test Testsson', personnummer, email: '', shares: 500, roles: ['ledamot'] }],
  }
}

describe('sealAnswers', () => {
  it('seals a valid personnummer and keeps only its last four digits readable', () => {
    const sealed = sealAnswers(withPerson('19500118-2046'), null)
    const p = sealed.parties[0]
    expect(p.type).toBe('person')
    if (p.type !== 'person') return
    expect(p.personnummer).toBe('')
    expect(p.personnummerLast4).toBe('2046')
    expect(p.personnummerSealed).toBeTruthy()
    expect(JSON.stringify(sealed)).not.toContain(PNR)
  })

  it('accepts the 10-digit form and expands it before sealing', () => {
    const sealed = sealAnswers(withPerson('500118-2046'), null, new Date('2026-11-20T12:00:00Z'))
    expect(openAnswers(sealed).parties[0]).toMatchObject({ personnummer: PNR })
  })

  it('never stores an invalid number', () => {
    const sealed = sealAnswers(withPerson('195001182047'), null)
    const p = sealed.parties[0]
    if (p.type !== 'person') throw new Error('person expected')
    expect(p.personnummer).toBe('')
    expect(p.personnummerSealed).toBeUndefined()
    expect(JSON.stringify(sealed)).not.toContain('195001182047')
  })

  it('keeps the earlier sealed number when the field comes back empty, and ignores a sealed value from the browser', () => {
    const first = sealAnswers(withPerson(PNR), null)
    const incoming = withPerson('')
    const p = incoming.parties[0]
    if (p.type === 'person') p.personnummerSealed = 'forged-by-browser'
    const second = sealAnswers(incoming, first)
    expect(openAnswers(second).parties[0]).toMatchObject({ personnummer: PNR })
  })

  it('publicAnswers strips the sealed value', () => {
    const view = publicAnswers(sealAnswers(withPerson(PNR), null))
    const p = view.parties[0]
    if (p.type !== 'person') throw new Error('person expected')
    expect(p.personnummerSealed).toBeUndefined()
    expect(p.personnummerLast4).toBe('2046')
  })
})

describe('firstFiscalYear', () => {
  it('runs a calendar-year company to the first year-end', () => {
    expect(firstFiscalYear('2026-11-25', 1, false)).toEqual({ start: '2026-11-25', end: '2026-12-31', extended: false })
  })
  it('extends to the next year-end when that stays within 18 months', () => {
    expect(firstFiscalYear('2026-11-25', 1, true)).toEqual({ start: '2026-11-25', end: '2027-12-31', extended: true })
  })
  it('does not extend past 18 months', () => {
    expect(firstFiscalYear('2026-03-10', 1, true)).toEqual({ start: '2026-03-10', end: '2026-12-31', extended: false })
  })
  it('follows a broken fiscal year', () => {
    expect(firstFiscalYear('2026-11-25', 7, false)).toEqual({ start: '2026-11-25', end: '2027-06-30', extended: false })
    expect(firstFiscalYear('2026-05-02', 7, false)).toEqual({ start: '2026-05-02', end: '2026-06-30', extended: false })
  })
})

describe('checkSetupInput', () => {
  const formation = { created_at: '2026-11-01T10:00:00Z' } as FormationRow
  const base = { orgNumber: '559538-6219', companyName: 'Test AB', registrationDate: '2026-11-12', beneficialOwnersConfirmed: true }

  it('accepts an aktiebolag registered after the formation started', () => {
    expect(checkSetupInput(base, formation, '2026-11-20')).toBeNull()
  })
  it('refuses an invalid organisation number', () => {
    expect(checkSetupInput({ ...base, orgNumber: '559538-6218' }, formation, '2026-11-20')).toBe('FORMATION_ORG_NUMBER_MISMATCH')
  })
  it('refuses a registration before the formation began, or in the future', () => {
    expect(checkSetupInput({ ...base, registrationDate: '2025-01-01' }, formation, '2026-11-20')).toBe('FORMATION_ORG_NUMBER_MISMATCH')
    expect(checkSetupInput({ ...base, registrationDate: '2026-12-01' }, formation, '2026-11-20')).toBe('FORMATION_ORG_NUMBER_MISMATCH')
  })
  it('refuses a company the register says is not an aktiebolag, or is ceased', () => {
    expect(checkSetupInput({ ...base, lookup: { companyName: 'X', legalEntityType: 'Enskild näringsidkare' } as never }, formation, '2026-11-20')).toBe(
      'FORMATION_ORG_NUMBER_MISMATCH',
    )
    expect(checkSetupInput({ ...base, lookup: { companyName: 'X', legalEntityType: 'Aktiebolag', isCeased: true } as never }, formation, '2026-11-20')).toBe(
      'FORMATION_ORG_NUMBER_MISMATCH',
    )
    expect(checkSetupInput({ ...base, lookup: { companyName: 'X', legalEntityType: 'Aktiebolag' } as never }, formation, '2026-11-20')).toBeNull()
  })
})
