import { describe, it, expect } from 'vitest'
import {
  JAMKNING_DB_ERROR_PREFIX,
  JAMKNING_END_REQUIRED,
  JAMKNING_ORDER,
  JAMKNING_START_REQUIRED,
  jamkningIssueFromDbError,
  touchesJamkning,
  validateJamkning,
} from '../jamkning-rules'

describe('validateJamkning', () => {
  it('accepts a complete beslut', () => {
    expect(
      validateJamkning({
        jamkning_percentage: 15,
        jamkning_valid_from: '2026-01-01',
        jamkning_valid_to: '2026-12-31',
      }),
    ).toEqual([])
  })

  it('accepts no beslut at all, with or without stray dates', () => {
    expect(validateJamkning({})).toEqual([])
    expect(
      validateJamkning({ jamkning_percentage: null, jamkning_valid_from: null, jamkning_valid_to: null }),
    ).toEqual([])
    expect(
      validateJamkning({ jamkning_percentage: null, jamkning_valid_from: '2026-01-01', jamkning_valid_to: null }),
    ).toEqual([])
  })

  it('requires the start date when a percentage is set', () => {
    const issues = validateJamkning({
      jamkning_percentage: 15,
      jamkning_valid_from: null,
      jamkning_valid_to: '2026-12-31',
    })
    expect(issues).toEqual([{ field: 'jamkning_valid_from', message: JAMKNING_START_REQUIRED }])
  })

  it('requires the end date when a percentage is set (#2058: the engine never applies a beslut without it)', () => {
    const issues = validateJamkning({
      jamkning_percentage: 15,
      jamkning_valid_from: '2026-01-01',
      jamkning_valid_to: null,
    })
    expect(issues).toEqual([{ field: 'jamkning_valid_to', message: JAMKNING_END_REQUIRED }])
  })

  it('treats an undefined end date like a null one', () => {
    const issues = validateJamkning({ jamkning_percentage: 15, jamkning_valid_from: '2026-01-01' })
    expect(issues.map((i) => i.field)).toEqual(['jamkning_valid_to'])
  })

  it('treats 0 % as a beslut (Skatteverket can decide on zero withholding)', () => {
    const issues = validateJamkning({ jamkning_percentage: 0, jamkning_valid_from: null, jamkning_valid_to: null })
    expect(issues.map((i) => i.field)).toEqual(['jamkning_valid_from', 'jamkning_valid_to'])
  })

  it('reports both missing dates in field order', () => {
    const issues = validateJamkning({ jamkning_percentage: 15 })
    expect(issues).toEqual([
      { field: 'jamkning_valid_from', message: JAMKNING_START_REQUIRED },
      { field: 'jamkning_valid_to', message: JAMKNING_END_REQUIRED },
    ])
  })

  it('rejects an end date before the start date', () => {
    const issues = validateJamkning({
      jamkning_percentage: 15,
      jamkning_valid_from: '2026-06-01',
      jamkning_valid_to: '2026-01-31',
    })
    expect(issues).toEqual([{ field: 'jamkning_valid_to', message: JAMKNING_ORDER }])
  })

  it('checks date ordering even without a percentage (schema body-only use)', () => {
    const issues = validateJamkning({
      jamkning_percentage: null,
      jamkning_valid_from: '2026-06-01',
      jamkning_valid_to: '2026-01-31',
    })
    expect(issues).toEqual([{ field: 'jamkning_valid_to', message: JAMKNING_ORDER }])
  })

  it('accepts a one-day window', () => {
    expect(
      validateJamkning({
        jamkning_percentage: 15,
        jamkning_valid_from: '2026-03-01',
        jamkning_valid_to: '2026-03-01',
      }),
    ).toEqual([])
  })
})

describe('touchesJamkning', () => {
  it('is true for any jämkning key, including an explicit null', () => {
    expect(touchesJamkning({ jamkning_percentage: 15 })).toBe(true)
    expect(touchesJamkning({ jamkning_valid_from: null })).toBe(true)
    expect(touchesJamkning({ jamkning_valid_to: '2026-12-31' })).toBe(true)
  })

  it('is false for an unrelated patch, so legacy rows stay editable', () => {
    expect(touchesJamkning({ first_name: 'Ny', monthly_salary: 38000 })).toBe(false)
    expect(touchesJamkning({})).toBe(false)
  })
})

describe('jamkningIssueFromDbError (#2256: the trigger backstop)', () => {
  it('recovers the issue from a 23514 trigger rejection, prefix stripped', () => {
    expect(
      jamkningIssueFromDbError({ code: '23514', message: `${JAMKNING_DB_ERROR_PREFIX}${JAMKNING_END_REQUIRED}` }),
    ).toEqual({ field: 'jamkning_valid_to', message: JAMKNING_END_REQUIRED })
    expect(
      jamkningIssueFromDbError({ code: '23514', message: `${JAMKNING_DB_ERROR_PREFIX}${JAMKNING_START_REQUIRED}` }),
    ).toEqual({ field: 'jamkning_valid_from', message: JAMKNING_START_REQUIRED })
    expect(
      jamkningIssueFromDbError({ code: '23514', message: `${JAMKNING_DB_ERROR_PREFIX}${JAMKNING_ORDER}` }),
    ).toEqual({ field: 'jamkning_valid_to', message: JAMKNING_ORDER })
  })

  it('carries the PostgrestError extras without reading them', () => {
    expect(
      jamkningIssueFromDbError({
        code: '23514',
        message: `${JAMKNING_DB_ERROR_PREFIX}${JAMKNING_END_REQUIRED}`,
        details: 'employees.jamkning_percentage is set but jamkning_valid_to is null (#2256)',
        hint: null,
      }),
    ).toEqual({ field: 'jamkning_valid_to', message: JAMKNING_END_REQUIRED })
  })

  it('ignores every other error', () => {
    expect(jamkningIssueFromDbError(null)).toBeNull()
    expect(jamkningIssueFromDbError('JAMKNING_INCOMPLETE: x')).toBeNull()
    expect(jamkningIssueFromDbError(new Error(`${JAMKNING_DB_ERROR_PREFIX}${JAMKNING_END_REQUIRED}`))).toBeNull()
    // Another check constraint on the same table.
    expect(
      jamkningIssueFromDbError({ code: '23514', message: 'new row for relation "employees" violates check constraint' }),
    ).toBeNull()
    // The prefix on a different SQLSTATE is not the trigger.
    expect(jamkningIssueFromDbError({ code: 'P0001', message: `${JAMKNING_DB_ERROR_PREFIX}${JAMKNING_END_REQUIRED}` })).toBeNull()
    expect(jamkningIssueFromDbError({ code: '23514', message: JAMKNING_DB_ERROR_PREFIX })).toBeNull()
    expect(jamkningIssueFromDbError({ code: '23514' })).toBeNull()
  })
})
