/**
 * validateEmployeeUpdate: the merged-state rules every employee update door
 * runs (dashboard PATCH, v1 PATCH, MCP staging + executor). #3008 made null
 * a legal "clear this" value on update, so the invariants that span a cleared
 * field and a stored one are pinned here on the merged row.
 */
import { describe, expect, it } from 'vitest'
import {
  HOURLY_RATE_REQUIRED,
  MONTHLY_SALARY_REQUIRED,
  TAX_TABLE_REQUIRED,
  VAXA_START_REQUIRED,
  validateEmployeeUpdate,
} from '../employee-update-rules'
import { JAMKNING_END_REQUIRED } from '../jamkning-rules'
import { BANK_ISSUE_MESSAGES_SV } from '../payment/bank-account'

const VALID_ROW = {
  salary_type: 'monthly',
  monthly_salary: 35000,
  hourly_rate: null,
  f_skatt_status: 'a_skatt',
  is_sidoinkomst: false,
  tax_table_number: 33,
  employment_start: '2024-01-15',
  employment_end: '2026-06-30',
  vaxa_stod_eligible: false,
  vaxa_stod_start: null,
  vaxa_stod_end: null,
  jamkning_percentage: null,
  jamkning_valid_from: null,
  jamkning_valid_to: null,
  clearing_number: '6000',
  bank_account_number: '12345678',
  email: 'anna@example.test',
}

describe('validateEmployeeUpdate', () => {
  it('lets a stored slutdatum be cleared (the #3008 case)', () => {
    expect(validateEmployeeUpdate(VALID_ROW, { employment_end: null })).toEqual([])
  })

  it('lets optional contact fields be cleared', () => {
    expect(validateEmployeeUpdate(VALID_ROW, { email: null, phone: null, city: null })).toEqual([])
  })

  it('treats an undefined value as an absent key, never as a clear', () => {
    expect(validateEmployeeUpdate(VALID_ROW, { monthly_salary: undefined })).toEqual([])
  })

  it('refuses clearing the monthly salary of a monthly employee', () => {
    expect(validateEmployeeUpdate(VALID_ROW, { monthly_salary: null })).toEqual([
      { field: 'monthly_salary', message: MONTHLY_SALARY_REQUIRED },
    ])
  })

  it('allows clearing the monthly salary when the same patch switches to hourly with a rate', () => {
    expect(
      validateEmployeeUpdate(VALID_ROW, { salary_type: 'hourly', hourly_rate: 250, monthly_salary: null }),
    ).toEqual([])
  })

  it('refuses switching to hourly without a rate on the row', () => {
    expect(validateEmployeeUpdate(VALID_ROW, { salary_type: 'hourly' })).toEqual([
      { field: 'hourly_rate', message: HOURLY_RATE_REQUIRED },
    ])
  })

  it('refuses clearing the tax table of an A-skatt employee without sidoinkomst', () => {
    expect(validateEmployeeUpdate(VALID_ROW, { tax_table_number: null })).toEqual([
      { field: 'tax_table_number', message: TAX_TABLE_REQUIRED },
    ])
  })

  it('allows clearing the tax table together with a switch to F-skatt', () => {
    expect(validateEmployeeUpdate(VALID_ROW, { f_skatt_status: 'f_skatt', tax_table_number: null })).toEqual([])
  })

  it('refuses clearing the Växa-stöd start while the stored flag is on', () => {
    const row = { ...VALID_ROW, vaxa_stod_eligible: true, vaxa_stod_start: '2026-01-01' }
    expect(validateEmployeeUpdate(row, { vaxa_stod_start: null })).toEqual([
      { field: 'vaxa_stod_start', message: VAXA_START_REQUIRED },
    ])
  })

  it('allows clearing the Växa-stöd dates together with turning the flag off', () => {
    const row = { ...VALID_ROW, vaxa_stod_eligible: true, vaxa_stod_start: '2026-01-01', vaxa_stod_end: '2026-12-31' }
    expect(
      validateEmployeeUpdate(row, { vaxa_stod_eligible: false, vaxa_stod_start: null, vaxa_stod_end: null }),
    ).toEqual([])
  })

  it('checks jämkning only when the patch names a jämkning key (#2058 touched gate)', () => {
    const legacy = { ...VALID_ROW, jamkning_percentage: 15, jamkning_valid_from: '2026-01-01', jamkning_valid_to: null }
    expect(validateEmployeeUpdate(legacy, { employment_end: null })).toEqual([])
    expect(validateEmployeeUpdate(legacy, { jamkning_percentage: 20 })).toEqual([
      { field: 'jamkning_valid_to', message: JAMKNING_END_REQUIRED },
    ])
  })

  it('allows clearing both bank fields', () => {
    expect(validateEmployeeUpdate(VALID_ROW, { clearing_number: null, bank_account_number: null })).toEqual([])
  })

  it('refuses clearing only one of the bank fields (both-or-neither)', () => {
    expect(validateEmployeeUpdate(VALID_ROW, { clearing_number: null })).toEqual([
      { field: 'clearing_number', message: BANK_ISSUE_MESSAGES_SV.clearing_required },
    ])
  })

  it('leaves legacy free-text bank data alone when the patch does not change it', () => {
    const legacy = { ...VALID_ROW, clearing_number: 'Swedbank', bank_account_number: null }
    expect(validateEmployeeUpdate(legacy, { employment_end: null })).toEqual([])
  })

  it('returns every issue in a stable order', () => {
    const row = { ...VALID_ROW, vaxa_stod_eligible: true, vaxa_stod_start: '2026-01-01' }
    const issues = validateEmployeeUpdate(row, {
      monthly_salary: null,
      tax_table_number: null,
      vaxa_stod_start: null,
      bank_account_number: null,
    })
    expect(issues.map((i) => i.field)).toEqual([
      'monthly_salary',
      'tax_table_number',
      'vaxa_stod_start',
      'bank_account_number',
    ])
  })
})
