import { describe, it, expect } from 'vitest'
import { isVaxaStodRefundMonth, vaxaStodLastDay, vaxaStodRefundWarning, VAXA_STOD_REFUND_FROM } from '../vaxa-stod'

describe('isVaxaStodRefundMonth', () => {
  const win = { eligible: true, start: '2025-06-01', end: '2027-05-31' }

  it('is a refund month inside the window from 2026-01-01', () => {
    expect(isVaxaStodRefundMonth(win, VAXA_STOD_REFUND_FROM)).toBe(true)
    expect(isVaxaStodRefundMonth(win, '2026-09-25')).toBe(true)
    expect(isVaxaStodRefundMonth(win, '2027-05-31')).toBe(true)
  })

  it('is never one before 2026: that pay fell under the old reduced-sats law', () => {
    expect(isVaxaStodRefundMonth(win, '2025-12-25')).toBe(false)
  })

  it('respects the window and the eligibility flag', () => {
    expect(isVaxaStodRefundMonth(win, '2027-06-25')).toBe(false)
    expect(isVaxaStodRefundMonth({ ...win, start: '2026-10-01' }, '2026-09-25')).toBe(false)
    expect(isVaxaStodRefundMonth({ ...win, eligible: false }, '2026-09-25')).toBe(false)
    expect(isVaxaStodRefundMonth({ ...win, start: null }, '2026-09-25')).toBe(false)
  })

  it('runs a window without an end date until the 24th calendar month (social-charges.md), not forever', () => {
    const open = { eligible: true, start: '2026-01-15', end: null }
    // Month 1 is 2026-01, month 24 is 2027-12.
    expect(isVaxaStodRefundMonth(open, '2026-09-25')).toBe(true)
    expect(isVaxaStodRefundMonth(open, '2027-12-31')).toBe(true)
    expect(isVaxaStodRefundMonth(open, '2028-01-25')).toBe(false)
    expect(isVaxaStodRefundMonth({ ...win, end: null }, '2027-05-25')).toBe(true)
    expect(isVaxaStodRefundMonth({ ...win, end: null }, '2027-06-25')).toBe(false)
  })

  it('never runs past 24 months even when the stored end date is later', () => {
    expect(isVaxaStodRefundMonth({ ...win, end: '2028-12-31' }, '2027-05-31')).toBe(true)
    expect(isVaxaStodRefundMonth({ ...win, end: '2028-12-31' }, '2027-06-25')).toBe(false)
  })

  it('is never one for a start date it cannot read', () => {
    expect(isVaxaStodRefundMonth({ ...win, start: 'juni 2025' }, '2026-09-25')).toBe(false)
  })
})

describe('vaxaStodLastDay', () => {
  it('is the last day of the 24th calendar month counted from the start month', () => {
    expect(vaxaStodLastDay('2025-06-01')).toBe('2027-05-31')
    expect(vaxaStodLastDay('2026-01-15')).toBe('2027-12-31')
    expect(vaxaStodLastDay('2026-03-31')).toBe('2028-02-29')
    expect(vaxaStodLastDay('2025-12-01')).toBe('2027-11-30')
  })

  it('is null for a date that is not YYYY-MM-DD', () => {
    expect(vaxaStodLastDay('')).toBeNull()
    expect(vaxaStodLastDay('2025/06/01')).toBeNull()
  })
})

describe('vaxaStodRefundWarning', () => {
  it('is null when no employee has a växa-stöd month', () => {
    expect(vaxaStodRefundWarning([])).toBeNull()
  })

  it('names every employee and says the refund has to be applied for', () => {
    const warning = vaxaStodRefundWarning(['Anna Andersson', 'Bo Berg'])
    expect(warning).toContain('Anna Andersson, Bo Berg')
    expect(warning).toContain('redovisas utan växa-stöd')
    expect(warning).toContain('Ansök om återbetalning hos Skatteverket')
    expect(warning).toContain('senast ett år efter kalendermånaden')
  })

  it('says the cap is per calendar month, since each payment is capped on its own', () => {
    expect(vaxaStodRefundWarning(['Anna Andersson'])).toContain('Taket gäller per kalendermånad')
  })
})
