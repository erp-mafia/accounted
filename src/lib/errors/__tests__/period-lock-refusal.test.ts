/**
 * The database's lock refusals are plain text (triggers are never edited),
 * so they are read in one table (DATABASE_REFUSALS). Routes and services ask
 * isPeriodLockRefusal / isLockDateRefusal instead of matching the sentences
 * themselves, and classifyError answers PERIOD_LOCKED for every one of them.
 */
import { describe, it, expect } from 'vitest'
import { classifyError, isLockDateRefusal, isPeriodLockRefusal } from '../get-structured-error'

const PERIOD = { code: 'P0001', message: 'Cannot write to locked/closed fiscal period "2025" (is_closed=t, locked_at=2026-01-31)' }
const LOCK_DATE = new Error('Bokföringen är låst t.o.m. 2025-12-31. Ändringar före detta datum kan inte göras.')
const TAX_ADJUSTMENTS = { code: 'P0001', message: 'Fiscal period is locked for tax adjustments' }
const TAX_ELECTIONS = { code: 'P0001', message: 'Fiscal period is locked for tax depreciation elections' }

describe('database lock refusals', () => {
  it.each([PERIOD, LOCK_DATE, TAX_ADJUSTMENTS, TAX_ELECTIONS])('classifies %o as PERIOD_LOCKED', (error) => {
    expect(classifyError(error).code).toBe('PERIOD_LOCKED')
    expect(isPeriodLockRefusal(error)).toBe(true)
  })

  it('reads a bare message as well as an error', () => {
    expect(isPeriodLockRefusal(PERIOD.message)).toBe(true)
    expect(isPeriodLockRefusal(null)).toBe(false)
    expect(isPeriodLockRefusal(undefined)).toBe(false)
  })

  it('tells the company lock date apart from a period lock', () => {
    expect(isLockDateRefusal(LOCK_DATE)).toBe(true)
    expect(isLockDateRefusal(PERIOD)).toBe(false)
    expect(isLockDateRefusal(TAX_ADJUSTMENTS)).toBe(false)
  })

  it('is false for any other failure', () => {
    expect(isPeriodLockRefusal(new Error('duplicate key value violates unique constraint'))).toBe(false)
    expect(isPeriodLockRefusal({ code: '42501', message: 'permission denied' })).toBe(false)
  })
})
