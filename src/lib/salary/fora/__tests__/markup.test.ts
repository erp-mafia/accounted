import { describe, it, expect } from 'vitest'
import {
  FORA_FOK_EMPLOYEE_ONLY,
  FORA_FOK_ID_FORMAT,
  FORA_FOK_ID_REQUIRED,
  FORA_FOK_START_REQUIRED,
  normalizeForaFokId,
  touchesForaMarkup,
  validateForaMarkup,
} from '../markup'

describe('validateForaMarkup', () => {
  it('accepts no code, and a code with its start date on an employee', () => {
    expect(validateForaMarkup({ employment_type: 'employee' })).toEqual([])
    expect(validateForaMarkup({ fora_fok_id: null, fora_fok_start_date: null })).toEqual([])
    expect(validateForaMarkup({ employment_type: 'employee', fora_fok_id: 'FOK306834', fora_fok_start_date: '2024-01-01' })).toEqual([])
    // employment_type defaults to 'employee' on create.
    expect(validateForaMarkup({ fora_fok_id: 'FOK306834', fora_fok_start_date: '2024-01-01' })).toEqual([])
  })

  it.each(['FOK12345', 'FOK1234567', 'fok306834', '306834'])('refuses the code %j', (code) => {
    expect(validateForaMarkup({ fora_fok_id: code, fora_fok_start_date: '2024-01-01' })).toEqual([
      { field: 'fora_fok_id', message: FORA_FOK_ID_FORMAT },
    ])
  })

  it('wants the code and the date together', () => {
    expect(validateForaMarkup({ fora_fok_id: 'FOK306834', fora_fok_start_date: null })).toEqual([
      { field: 'fora_fok_start_date', message: FORA_FOK_START_REQUIRED },
    ])
    expect(validateForaMarkup({ fora_fok_id: null, fora_fok_start_date: '2024-01-01' })).toEqual([
      { field: 'fora_fok_id', message: FORA_FOK_ID_REQUIRED },
    ])
  })

  it.each(['company_owner', 'board_member'])('refuses a code on %s', (employment_type) => {
    expect(validateForaMarkup({ employment_type, fora_fok_id: 'FOK306834', fora_fok_start_date: '2024-01-01' })).toEqual([
      { field: 'fora_fok_id', message: FORA_FOK_EMPLOYEE_ONLY },
    ])
  })
})

describe('normalizeForaFokId', () => {
  it('trims and upper-cases, and treats empty as no code', () => {
    expect(normalizeForaFokId(' fok306834 ')).toBe('FOK306834')
    expect(normalizeForaFokId('')).toBeNull()
    expect(normalizeForaFokId(null)).toBeNull()
  })
})

describe('touchesForaMarkup', () => {
  it('is true for the two columns and for employment_type', () => {
    expect(touchesForaMarkup({ fora_fok_id: null })).toBe(true)
    expect(touchesForaMarkup({ fora_fok_start_date: '2024-01-01' })).toBe(true)
    expect(touchesForaMarkup({ employment_type: 'company_owner' })).toBe(true)
    expect(touchesForaMarkup({ phone: '070' })).toBe(false)
  })
})
