import { describe, expect, it } from 'vitest'
import raw from '../field-table-2026P4.json'
import {
  INK3_FIELD_TABLES,
  Ink3PeriodNotSupportedError,
  ink3Beskattningsperiod,
  resolveInk3FieldTable,
} from '../field-table'
import { ink3Layout, INK3_DERIVED_CODES, INK3_EXCLUSIVE_PAIRS } from '../layout'

/**
 * The 2026P4 table is derived from Skatteverket's field-name xls files
 * (INK3R_SKV2003-33-02-26-07, INK3S_SKV2003-33-01-26-07,
 * INK3SUF_SKV2003-33-01-26-01). These pin what the engine relies on, so a
 * re-derived table that moves a code fails here first.
 */

const table = INK3_FIELD_TABLES['2026P4']
const code = (c: string) => table.byCode.get(c)

function codeRange(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => String(from + i))
}

describe('INK3 field table 2026P4: provenance', () => {
  it('records the Skatteverket files it was derived from', () => {
    expect(raw.beskattningsperiod).toBe('2026P4')
    expect(raw.source.files.map((f) => f.file)).toEqual([
      'INK3R_SKV2003-33-02-26-07.xls',
      'INK3S_SKV2003-33-01-26-07.xls',
      'INK3SUF_SKV2003-33-01-26-01.xls',
      'Vardeforrad_2027.xls',
    ])
    for (const file of raw.source.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(raw.source.package).toContain('_Nyheter_from_beskattningsperiod_2026P4.zip')
  })

  it('has one row per four-digit code and a definition for every datatyp', () => {
    const codes = table.fields.map((f) => f.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const field of table.fields) {
      expect(field.code).toMatch(/^\d{4}$/)
      expect(table.datatypes[field.datatyp], field.code).toBeDefined()
    }
  })
})

describe('INK3 field table 2026P4: INK3R', () => {
  it('puts the balance sheet on 5.1-5.21 (8720-8730, 8735-8744)', () => {
    const layout = ink3Layout(table)
    expect(layout.assetCodes).toEqual(codeRange(8720, 8730))
    expect(layout.equityLiabilityCodes).toEqual(codeRange(8735, 8744))
    expect(code('8720')?.ruta).toBe('5.1')
    expect(code('8744')?.ruta).toBe('5.21')
  })

  it('splits the income statement into the two columns of the blankett', () => {
    for (const field of table.fields.filter((f) => f.blankett === 'INK3R' && f.column)) {
      const n = Number(field.code)
      const bokforing = (n >= 8650 && n <= 8663) || (n >= 8750 && n <= 8763)
      expect(field.column, field.code).toBe(bokforing ? 'bokforing' : 'skattepliktig')
    }
  })

  it('gives every bookkeeping box a taxable twin except 6.1 Medlemsavgifter and 6.19 Skatt', () => {
    const layout = ink3Layout(table)
    const withoutTwin = [...layout.taxableTwin].filter(([, twin]) => twin === null).map(([c]) => code(c)?.ruta)
    expect(withoutTwin).toEqual(['6.1', '6.19'])
    expect(layout.taxableTwin.get('8651')).toBe('8671')
    expect(layout.taxableTwin.get('8755')).toBe('8775')
    expect(layout.taxableTwin.get('8761')).toBe('8781')
    expect(layout.incomeStatement).toHaveLength(22)
  })

  it('files 6.20 Årets resultat as 8663/8763, not BAS\'s 8665, and 6.21 as 8685/8785', () => {
    expect(code('8663')?.ruta).toBe('6.20')
    expect(code('8763')?.ruta).toBe('6.20')
    expect(code('8665')).toBeUndefined()
    expect(code('8685')?.ruta).toBe('6.21')
    expect(code('8785')?.ruta).toBe('6.21')
  })
})

describe('INK3 field table 2026P4: INK3S and INK3SUF', () => {
  it('carries 6.21 to 7.1/7.2 and sums rows 7.1-7.8 into 7.9/7.10 by their printed sign', () => {
    expect(code('8686')?.ruta).toBe('7.1')
    expect(code('8786')?.ruta).toBe('7.2')
    expect(code('8695')?.ruta).toBe('7.9')
    expect(code('8795')?.ruta).toBe('7.10')
    expect(ink3Layout(table).surplusTerms).toEqual([
      { code: '8686', factor: 1 },
      { code: '8786', factor: -1 },
      { code: '8787', factor: -1 },
      { code: '8687', factor: 1 },
      { code: '8788', factor: -1 },
      { code: '8688', factor: 1 },
      { code: '8693', factor: 1 },
      { code: '8696', factor: 1 },
      { code: '8689', factor: 1 },
      { code: '8690', factor: 1 },
      { code: '8789', factor: -1 },
      { code: '8790', factor: -1 },
      { code: '8691', factor: 1 },
    ])
  })

  it('has 7.5a schablonintäkt on 8688 and the new 2026P4 field 8037 (pensionskostnader) as Numeriskt_A', () => {
    expect(code('8688')?.ruta).toBe('7.5a')
    expect(code('8037')?.ruta).toBe('7.15')
    expect(code('8037')?.datatyp).toBe('Numeriskt_A')
    expect(raw.notes['8688']).toMatch(/ingång/)
  })

  it('lists the INK3SUF income 4.1-4.6 and costs 4.7-4.12', () => {
    const suf = (r: string) => table.fields.find((f) => f.blankett === 'INK3SUF' && f.ruta === r)?.code
    expect(['4.1', '4.2', '4.3', '4.4', '4.5', '4.6'].map(suf)).toEqual(['8640', '8641', '8642', '8643', '8629', '8644'])
    expect(['4.7', '4.8', '4.9', '4.10', '4.11', '4.12'].map(suf)).toEqual(codeRange(8713, 8718))
    expect(code('8614')?.datatyp).toBe('Numeriskt_N')
    expect(code('8620')?.datatyp).toBe('Str_36')
  })

  it('knows every derived code and exclusive pair', () => {
    for (const c of INK3_DERIVED_CODES) expect(code(c), c).toBeDefined()
    for (const [a, b] of INK3_EXCLUSIVE_PAIRS) {
      expect(code(a)?.datatyp).toBe('Str_X')
      expect(code(b)?.datatyp).toBe('Str_X')
      expect(code(a)?.rule).toContain(b)
    }
  })
})

describe('INK3 beskattningsperiod', () => {
  it.each([
    ['2026-12-31', '2026P4'],
    ['2026-09-30', '2026P4'],
    ['2026-08-31', '2026P3'],
    ['2026-06-30', '2026P2'],
    ['2027-04-30', '2027P1'],
  ])('a räkenskapsår ending %s belongs to %s', (end, period) => {
    expect(ink3Beskattningsperiod(end)).toBe(period)
  })

  it('resolves the pinned 2026P4 table', () => {
    expect(resolveInk3FieldTable('2026-12-31')).toBe(table)
    expect(resolveInk3FieldTable('2026-09-30')).toBe(table)
  })

  it.each(['2025-12-31', '2026-06-30', '2027-04-30'])('refuses %s instead of guessing its codes', (end) => {
    let error: unknown
    try {
      resolveInk3FieldTable(end)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(Ink3PeriodNotSupportedError)
    expect((error as Ink3PeriodNotSupportedError).code).toBe('TAX_DECL_INK3_PERIOD_NOT_SUPPORTED')
    expect((error as Ink3PeriodNotSupportedError).supported).toEqual(['2026P4'])
    expect((error as Error).message).toContain(ink3Beskattningsperiod(end))
  })
})
