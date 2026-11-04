import { describe, expect, it } from 'vitest'
import { findReopenableImportPeriod, type ImportFiscalPeriod } from '../reopen-import-period'
const period: ImportFiscalPeriod = { id: 'p1', name: '2018', period_start: '2018-06-28', period_end: '2018-12-31', is_closed: true, locked_at: null, closed_externally: true, closing_entry_id: null }
const file = { fiscalYearStart: '2018-06-28', fiscalYearEnd: '2018-12-31' }
describe('findReopenableImportPeriod', () => {
  it('offers the externally closed matching year, including its lock', () => {
    expect(findReopenableImportPeriod([period], [file])).toEqual(period)
    expect(findReopenableImportPeriod([{ ...period, locked_at: '2019-01-01' }], [file])?.id).toBe('p1')
  })
  it.each([
    { closing_entry_id: 'closing-voucher' },
    { closed_externally: false },
    { is_closed: false, locked_at: '2019-01-01' },
    { is_closed: false },
  ])('does not offer reopening for protected or open states: %j', (state) => {
    expect(findReopenableImportPeriod([{ ...period, ...state }], [file])).toBeNull()
  })
  it('ignores unrelated periods and ambiguous matches', () => {
    expect(findReopenableImportPeriod([period], [{ fiscalYearStart: '2020-01-01', fiscalYearEnd: '2020-12-31' }])).toBeNull()
    expect(findReopenableImportPeriod([period, { ...period, id: 'p2' }], [file])).toBeNull()
  })
  it('does not infer a recovery year from absent or malformed file bounds', () => {
    expect(findReopenableImportPeriod([period], [{}])).toBeNull()
    expect(findReopenableImportPeriod([period], [{ ...file, fiscalYearStart: '2018' }])).toBeNull()
    expect(findReopenableImportPeriod([period], [{ ...file, fiscalYearStart: '2019-01-01' }])).toBeNull()
  })
  it('checks all years chronologically before any import, not file order', () => {
    const later = { ...period, id: 'p2', period_start: '2019-01-01', period_end: '2019-12-31' }
    expect(findReopenableImportPeriod([later, period], [{ fiscalYearStart: '2019-01-01', fiscalYearEnd: '2019-12-31' }, file])?.id).toBe('p1')
    expect(findReopenableImportPeriod([{ ...period, closing_entry_id: 'closed-in-accounted' }, later], [file, { fiscalYearStart: '2019-01-01', fiscalYearEnd: '2019-12-31' }])).toBeNull()
  })
})
