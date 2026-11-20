import { describe, expect, it } from 'vitest'
import {
  ACCOUNTING_METHOD_MISSING,
  ACCOUNTING_METHOD_UNREADABLE,
  AccountingMethodUnavailableError,
  checkAccountingMethod,
  parseAccountingMethod,
  requireAccountingMethod,
} from '../accounting-method'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getStructuredError } from '@/lib/errors/get-structured-error'

describe('requireAccountingMethod', () => {
  it('returns the stored method from a readable row', () => {
    expect(requireAccountingMethod({ data: { accounting_method: 'cash' }, error: null })).toBe('cash')
    expect(requireAccountingMethod({ data: { accounting_method: 'accrual' }, error: null })).toBe('accrual')
  })

  it('refuses a failed read instead of defaulting to accrual (accounted#58)', () => {
    try {
      requireAccountingMethod({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AccountingMethodUnavailableError)
      expect((err as AccountingMethodUnavailableError).code).toBe(ACCOUNTING_METHOD_UNREADABLE)
      expect((err as AccountingMethodUnavailableError).reason).toBe('read_failed')
    }
  })

  it('refuses a missing row, from maybeSingle (null data) and from single (PGRST116)', () => {
    for (const read of [
      { data: null, error: null },
      { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },
    ]) {
      try {
        requireAccountingMethod(read)
        expect.unreachable()
      } catch (err) {
        expect((err as AccountingMethodUnavailableError).code).toBe(ACCOUNTING_METHOD_MISSING)
        expect((err as AccountingMethodUnavailableError).reason).toBe('missing')
      }
    }
  })

  it('refuses a row read without the column, and a value outside the two methods', () => {
    expect(() => requireAccountingMethod({ data: { entity_type: 'aktiebolag' }, error: null })).toThrow(
      AccountingMethodUnavailableError,
    )
    expect(() => parseAccountingMethod('kontant')).toThrow(AccountingMethodUnavailableError)
    expect(() => parseAccountingMethod('')).toThrow(AccountingMethodUnavailableError)
  })
})

describe('checkAccountingMethod', () => {
  it('answers a result for the paths that return refusals', () => {
    expect(checkAccountingMethod({ data: { accounting_method: 'cash' }, error: null })).toEqual({
      ok: true,
      accountingMethod: 'cash',
    })
    const refused = checkAccountingMethod({ data: null, error: { message: 'connection reset' } })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe(ACCOUNTING_METHOD_UNREADABLE)
    expect(refused.details).toEqual({ reason: 'read_failed' })
  })
})

describe('registry', () => {
  it('registers both codes: an unreadable method is retryable, a missing one is not', () => {
    expect(getErrorEntry(ACCOUNTING_METHOD_UNREADABLE)).toMatchObject({ httpStatus: 503, retryable: true })
    expect(getErrorEntry(ACCOUNTING_METHOD_MISSING)?.httpStatus).toBe(409)
    expect(getErrorEntry(ACCOUNTING_METHOD_MISSING)?.retryable).toBeUndefined()
  })

  it('a thrown refusal reaches REST and MCP as its own code with the Swedish message', () => {
    const structured = getStructuredError(new AccountingMethodUnavailableError('read_failed', 'connection reset'))
    expect(structured.code).toBe(ACCOUNTING_METHOD_UNREADABLE)
    expect(structured.retryable).toBe(true)
    expect(structured.message_sv).toBe(getErrorEntry(ACCOUNTING_METHOD_UNREADABLE)?.message_sv)
  })
})
