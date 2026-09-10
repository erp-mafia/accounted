import { describe, it, expect } from 'vitest'
import { looksLikePersonnummer, mapCustomer } from '../entity-mapper'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import type { CustomerDto } from '@/lib/providers/dto'

/**
 * #2469: customers_personal_number_check bounds the ciphertext length, so an
 * individual whose identity number is shorter than a personnummer (a birth
 * date, a customer number in the wrong field) failed the insert and the
 * whole row was dropped. Only a personnummer-shaped value is encrypted into
 * the column; anything else stays readable in the notes.
 */

function individual(number: string | null, note?: string): CustomerDto {
  return {
    id: 'cust-1',
    customerNumber: '1',
    type: 'private',
    party: {
      name: 'Anna Privatperson',
      identifications: number ? [{ schemeId: 'SE:ORGNR', id: number }] : [],
    },
    active: true,
    defaultPaymentTermsDays: 30,
    note,
  }
}

describe('looksLikePersonnummer', () => {
  it('accepts 10 and 12 digits with or without a separator', () => {
    expect(looksLikePersonnummer('8501011234')).toBe(true)
    expect(looksLikePersonnummer('850101-1234')).toBe(true)
    expect(looksLikePersonnummer('198501011234')).toBe(true)
    expect(looksLikePersonnummer('19850101-1234')).toBe(true)
    expect(looksLikePersonnummer('850101+1234')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(looksLikePersonnummer('850101')).toBe(false)
    expect(looksLikePersonnummer('1234')).toBe(false)
    expect(looksLikePersonnummer('')).toBe(false)
    expect(looksLikePersonnummer('85010112345')).toBe(false)
    expect(looksLikePersonnummer('K-12345678')).toBe(false)
  })
})

describe('mapCustomer: personal_number shape guard', () => {
  it('encrypts a personnummer-shaped identity number into personal_number', () => {
    const row = mapCustomer(individual('850101-1234'), 'user-1', 'company-1')

    expect(row.org_number).toBeNull()
    expect(typeof row.personal_number).toBe('string')
    expect(row.personal_number).toMatch(/^[0-9a-f]{76,255}$/)
    expect(decryptPersonnummer(row.personal_number as string)).toBe('850101-1234')
    expect(row.notes).toBeNull()
  })

  it('keeps a short identity number out of the column and in the notes instead', () => {
    const row = mapCustomer(individual('850101'), 'user-1', 'company-1')

    expect(row.personal_number).toBeNull()
    expect(row.org_number).toBeNull()
    expect(row.notes).toBe('Identitetsnummer i källsystemet: 850101')
  })

  it('appends the unstorable number after the provider note', () => {
    const row = mapCustomer(individual('1234', 'Betalar alltid sent'), 'user-1', 'company-1')

    expect(row.notes).toBe('Betalar alltid sent\nIdentitetsnummer i källsystemet: 1234')
  })

  it('leaves personal_number and notes null when there is no identity number', () => {
    const row = mapCustomer(individual(null), 'user-1', 'company-1')

    expect(row.personal_number).toBeNull()
    expect(row.notes).toBeNull()
  })
})
