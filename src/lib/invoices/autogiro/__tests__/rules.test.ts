import { describe, expect, it } from 'vitest'
import { addBankingDays, debitDateFor, debitReference, normalizePayerNumber } from '../rules'

describe('normalizePayerNumber', () => {
  it('keeps digits without leading zeros, as Bankgirot compares them', () => {
    expect(normalizePayerNumber('0001234')).toBe('1234')
    expect(normalizePayerNumber(' 19 90 01-01 ')).toBe('19900101')
    expect(normalizePayerNumber('0')).toBe('0')
  })

  it('refuses what is not 1-16 digits', () => {
    expect(normalizePayerNumber('')).toBeNull()
    expect(normalizePayerNumber('12a4')).toBeNull()
    expect(normalizePayerNumber('12345678901234567')).toBeNull()
    expect(normalizePayerNumber(null)).toBeNull()
  })
})

describe('addBankingDays', () => {
  it('counts banking days after the day, skipping weekends and holidays', () => {
    // Friday 2026-10-30 + 1 banking day: Monday 2 November.
    expect(addBankingDays('2026-10-30', 1)).toBe('2026-11-02')
    // Wednesday 2026-12-23 + 1: julafton, juldagen, annandag jul and the weekend are skipped.
    expect(addBankingDays('2026-12-23', 1)).toBe('2026-12-28')
    // Monday 2026-11-02 + 8: Wednesday 12 November.
    expect(addBankingDays('2026-11-02', 8)).toBe('2026-11-12')
  })
})

describe('debitDateFor', () => {
  it('debits on the due date when the customer has had eight banking days of notice', () => {
    expect(debitDateFor({ dueDate: '2026-11-30', noticeDate: '2026-11-02', today: '2026-11-20' })).toBe('2026-11-30')
  })

  it('moves a due date on a weekend to the next banking day', () => {
    // Saturday 28 November.
    expect(debitDateFor({ dueDate: '2026-11-28', noticeDate: '2026-11-02', today: '2026-11-20' })).toBe('2026-11-30')
  })

  it('never debits before eight banking days after the invoice went out', () => {
    // Sent Monday 2 November with a 5-day term: the earliest debit is Thursday 12 November.
    expect(debitDateFor({ dueDate: '2026-11-07', noticeDate: '2026-11-02', today: '2026-11-03' })).toBe('2026-11-12')
  })

  it('never debits before the first banking day after today (the file reaches Bankgirot the day before)', () => {
    expect(debitDateFor({ dueDate: '2026-11-10', noticeDate: '2026-10-01', today: '2026-11-20' })).toBe('2026-11-23')
  })
})

describe('debitReference', () => {
  it('takes an OCR of 2-16 digits and nothing else', () => {
    expect(debitReference('10017')).toBe('10017')
    expect(debitReference('1234567890123456')).toBe('1234567890123456')
    expect(debitReference('12345678901234567')).toBeNull()
    expect(debitReference('F-1001')).toBeNull()
  })
})
