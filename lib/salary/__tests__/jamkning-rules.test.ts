import { describe, it, expect } from 'vitest'
import {
  JAMKNING_CHECK_CONSTRAINT,
  JAMKNING_END_REQUIRED,
  JAMKNING_ORDER,
  JAMKNING_ROW_INCOMPLETE,
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

// The PostgREST error for a violated CHECK constraint, as observed against a
// real PostgREST (tests/tool-pg): the constraint name is in `message` only,
// and `details` carries the failing row, which no caller may echo.
const CHECK_ERROR = {
  code: '23514',
  details: 'Failing row contains (...).',
  hint: null,
  message: `new row for relation "employees" violates check constraint "${JAMKNING_CHECK_CONSTRAINT}"`,
}

describe('jamkningIssueFromDbError (#2256: the CHECK constraint backstop)', () => {
  it('recovers the validator sentence from the merged row (a legacy incomplete row on its next edit)', () => {
    expect(
      jamkningIssueFromDbError(CHECK_ERROR, {
        jamkning_percentage: 15,
        jamkning_valid_from: '2026-01-01',
        jamkning_valid_to: null,
      }),
    ).toEqual({ field: 'jamkning_valid_to', message: JAMKNING_END_REQUIRED })
    expect(
      jamkningIssueFromDbError(CHECK_ERROR, { jamkning_percentage: 15, jamkning_valid_from: null, jamkning_valid_to: null }),
    ).toEqual({ field: 'jamkning_valid_from', message: JAMKNING_START_REQUIRED })
    expect(
      jamkningIssueFromDbError(CHECK_ERROR, {
        jamkning_percentage: 15,
        jamkning_valid_from: '2026-06-01',
        jamkning_valid_to: '2026-01-31',
      }),
    ).toEqual({ field: 'jamkning_valid_to', message: JAMKNING_ORDER })
  })

  it('falls back to the umbrella sentence when the merged row is valid (a concurrent change)', () => {
    expect(
      jamkningIssueFromDbError(CHECK_ERROR, {
        jamkning_percentage: 15,
        jamkning_valid_from: '2026-01-01',
        jamkning_valid_to: '2026-12-31',
      }),
    ).toEqual({ field: 'jamkning_valid_to', message: JAMKNING_ROW_INCOMPLETE })
    expect(jamkningIssueFromDbError(CHECK_ERROR)).toEqual({ field: 'jamkning_valid_to', message: JAMKNING_ROW_INCOMPLETE })
  })

  it('accepts the node-postgres shape, which names the constraint in its own field', () => {
    expect(
      jamkningIssueFromDbError({ code: '23514', message: 'anything', constraint: JAMKNING_CHECK_CONSTRAINT }),
    ).toEqual({ field: 'jamkning_valid_to', message: JAMKNING_ROW_INCOMPLETE })
  })

  it('ignores every other error', () => {
    expect(jamkningIssueFromDbError(null)).toBeNull()
    expect(jamkningIssueFromDbError(CHECK_ERROR.message)).toBeNull()
    // Another CHECK constraint on the same table.
    expect(
      jamkningIssueFromDbError({
        code: '23514',
        message: 'new row for relation "employees" violates check constraint "employees_tax_column_check"',
      }),
    ).toBeNull()
    // The constraint name under a different SQLSTATE is not the constraint.
    expect(jamkningIssueFromDbError({ code: 'P0001', message: CHECK_ERROR.message })).toBeNull()
    expect(jamkningIssueFromDbError({ code: '23514' })).toBeNull()
  })
})
