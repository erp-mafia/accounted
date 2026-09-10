import { describe, it, expect } from 'vitest'
import { fitsPersonalNumberColumn, mapCustomer } from '../entity-mapper'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import type { CustomerDto } from '@/lib/providers/dto'

/**
 * #2469: customers_personal_number_check bounds the ciphertext length, so an
 * individual whose identity number is shorter than a personnummer (a birth
 * date, a customer number in the wrong field) failed the insert and the
 * whole row was dropped. Everything the column can hold is encrypted into
 * it (so a mistyped personnummer never lands in plaintext); a value that
 * cannot be a personnummer is omitted, never written to a plaintext field.
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

describe('fitsPersonalNumberColumn', () => {
  it('accepts every personnummer spelling, mistyped ones included', () => {
    expect(fitsPersonalNumberColumn('8501011234')).toBe(true)
    expect(fitsPersonalNumberColumn('850101-1234')).toBe(true)
    expect(fitsPersonalNumberColumn('198501011234')).toBe(true)
    expect(fitsPersonalNumberColumn('19850101-1234')).toBe(true)
    expect(fitsPersonalNumberColumn('850101+1234')).toBe(true)
    // One digit short or long: still personnummer-like, still encrypted.
    expect(fitsPersonalNumberColumn('19850101-123')).toBe(true)
    expect(fitsPersonalNumberColumn('85010112345')).toBe(true)
    expect(fitsPersonalNumberColumn('K-12345678')).toBe(true)
  })

  it('rejects only what the column cannot hold', () => {
    expect(fitsPersonalNumberColumn('850101')).toBe(false)
    expect(fitsPersonalNumberColumn('1234')).toBe(false)
    expect(fitsPersonalNumberColumn('')).toBe(false)
    expect(fitsPersonalNumberColumn('x'.repeat(100))).toBe(false)
  })

  it('matches the check constraint on the ciphertext length', () => {
    for (const value of ['8501011234', 'x'.repeat(99)]) {
      const row = mapCustomer(individual(value), 'user-1', 'company-1')
      expect(row.personal_number).toMatch(/^[0-9a-f]{76,255}$/)
    }
  })
})

describe('mapCustomer: personal_number shape guard', () => {
  it('encrypts a mistyped personnummer too, never leaving it in plaintext', () => {
    const row = mapCustomer(individual('19850101-123'), 'user-1', 'company-1')

    expect(row.personal_number).toMatch(/^[0-9a-f]{76,255}$/)
    expect(row.notes).toBeNull()
  })

  it('encrypts a personnummer-shaped identity number into personal_number', () => {
    const row = mapCustomer(individual('850101-1234'), 'user-1', 'company-1')

    expect(row.org_number).toBeNull()
    expect(typeof row.personal_number).toBe('string')
    expect(row.personal_number).toMatch(/^[0-9a-f]{76,255}$/)
    expect(decryptPersonnummer(row.personal_number as string)).toBe('850101-1234')
    expect(row.notes).toBeNull()
  })

  it('omits a short identity number entirely: the row imports, nothing lands in plaintext', () => {
    const row = mapCustomer(individual('850101'), 'user-1', 'company-1')

    expect(row.personal_number).toBeNull()
    expect(row.org_number).toBeNull()
    expect(row.notes).toBeNull()
    expect(JSON.stringify(row)).not.toContain('850101')
  })

  it('leaves the provider note untouched when the number is omitted', () => {
    const row = mapCustomer(individual('1234', 'Betalar alltid sent'), 'user-1', 'company-1')

    expect(row.notes).toBe('Betalar alltid sent')
    expect(JSON.stringify(row)).not.toContain('1234')
  })

  it('leaves personal_number and notes null when there is no identity number', () => {
    const row = mapCustomer(individual(null), 'user-1', 'company-1')

    expect(row.personal_number).toBeNull()
    expect(row.notes).toBeNull()
  })
})
