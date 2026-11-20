/**
 * A file that uses a series and number twice (crm#1653: two year-end
 * vouchers numbered again with numbers the year's own vouchers already had).
 * journal_import_source_owned_idx keeps (series, source number) unique per
 * year, so the import wrote everything before the repeat and then failed the
 * same chunk on every retry. Both vouchers are bookkeeping: the repeat is
 * booked last in its series without a source key, and every other voucher
 * keeps its place and its source number.
 */
import { describe, expect, it } from 'vitest'
import { moveRepeatedVoucherNumbersLast, parseSIEFile, validateSIEFile } from '../sie-parser'
import { prepareSIEVouchers } from '../sie-import'
import type { SIEVoucher } from '../types'

const ver = (series: string, number: string, date: string, text: string, amount: number) => [
  `#VER ${series} ${number} ${date} "${text}"`, '{', `#TRANS 1930 {} ${amount}.00`, `#TRANS 3001 {} -${amount}.00`, '}',
]

const FILE = [
  '#FLAGGA 0', '#PROGRAM "Capego Bokslut" "1.0"', '#SIETYP 4', '#RAR 0 20250201 20260131',
  ...ver('A', '1', '20250203', 'Första', 100),
  ...ver('A', '2', '20250207', 'Andra', 200),
  ...ver('A', '2', '20260131', 'Bokslut', 300),
  ...ver('A', '3', '20250210', 'Tredje', 400),
  ...ver('B', '1', '20250301', 'Annan serie', 500),
].join('\n')
const ACCOUNTS = new Map([['1930', '1930'], ['3001', '3001']])

function prepare(content = FILE) {
  const parsed = parseSIEFile(content)
  const result = prepareSIEVouchers(parsed, ACCOUNTS, 'A', 'import-1', { startOrdinal: 0, accountIds: new Map() })
  return { parsed, entries: result.preparedEntries, gaps: result.pendingNumberGaps }
}

describe('a voucher number the file uses twice (crm#1653)', () => {
  it('moves the repeat after every other voucher, marked, and keeps all vouchers', () => {
    const { parsed } = prepare()
    expect(parsed.vouchers.map((v) => `${v.series}${v.number}:${v.description}`)).toEqual([
      'A1:Första', 'A2:Andra', 'A3:Tredje', 'B1:Annan serie', 'A2:Bokslut',
    ])
    expect(parsed.vouchers.map((v) => v.numberRepeated === true)).toEqual([false, false, false, false, true])
    expect(parsed.stats.totalVouchers).toBe(5)
  })

  it('books the repeat without a source key, under a reference of its own', () => {
    const { entries, gaps } = prepare()
    expect(entries.map((e) => [e.sourceId, e.series, e.sourceSeries, e.sourceNumber])).toEqual([
      ['A1', 'A', 'A', 1], ['A2', 'A', 'A', 2], ['A3', 'A', 'A', 3], ['B1', 'B', 'B', 1], ['A2#5', 'A', 'A', null],
    ])
    // No (series, source number) pair twice: journal_import_source_owned_idx holds.
    const keys = entries.filter((e) => e.sourceNumber !== null).map((e) => `${e.sourceSeries}${e.sourceNumber}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(entries.map((e) => e.sourceId)).size).toBe(entries.length)
    // The text names the source voucher the number no longer does; nothing is held.
    expect(entries[4].description).toBe('Bokslut (A2 i filen, numret upprepas)')
    expect(entries.every((e) => e.numberGap === undefined)).toBe(true)
    expect(gaps).toEqual({})
  })

  it('warns in the preview, naming the repeated numbers, without blocking the import', () => {
    const { parsed } = prepare()
    const issue = parsed.issues.find((i) => i.tag === 'VER' && i.severity === 'warning')
    expect(issue?.message).toContain('A2')
    expect(issue?.message).toContain('Båda verifikationerna bokförs')
    expect(validateSIEFile(parsed).valid).toBe(true)
  })

  it('leaves a file without repeats exactly as it was', () => {
    const content = FILE.replace('#VER A 2 20260131', '#VER A 4 20260131')
    const { parsed, entries } = prepare(content)
    expect(parsed.vouchers.map((v) => `${v.series}${v.number}`)).toEqual(['A1', 'A2', 'A4', 'A3', 'B1'])
    expect(parsed.vouchers.some((v) => v.numberRepeated)).toBe(false)
    expect(entries.map((e) => e.sourceId)).toEqual(['A1', 'A2', 'A4', 'A3', 'B1'])
    expect(parsed.issues.some((i) => i.tag === 'VER' && i.severity === 'warning')).toBe(false)
  })

  it('never treats vouchers without a source number or series as repeats', () => {
    const base = { date: new Date('2026-01-01'), description: '', lines: [] }
    const vouchers: SIEVoucher[] = [
      { ...base, series: '', number: 0, numberOmitted: true },
      { ...base, series: '', number: 0, numberOmitted: true },
      { ...base, series: '', number: 7 },
      { ...base, series: '', number: 7 },
      { ...base, series: 'A', number: 7 },
    ]
    expect(moveRepeatedVoucherNumbersLast(vouchers)).toEqual([])
    expect(vouchers.some((v) => v.numberRepeated)).toBe(false)
  })

  it('names every repeat of a number used three times', () => {
    const base = { date: new Date('2026-01-01'), description: '', lines: [] }
    const vouchers: SIEVoucher[] = [
      { ...base, series: 'A', number: 1 }, { ...base, series: 'A', number: 1 }, { ...base, series: 'A', number: 1 },
      { ...base, series: 'A', number: 2 },
    ]
    expect(moveRepeatedVoucherNumbersLast(vouchers)).toEqual(['A1', 'A1'])
    expect(vouchers.map((v) => `${v.number}:${v.numberRepeated === true}`)).toEqual(['1:false', '2:false', '1:true', '1:true'])
  })
})
