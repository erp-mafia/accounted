import { describe, it, expect } from 'vitest'
import {
  buildPeriodiskSammanstallningCsv,
  formatPeriodCode,
  PsCsvBuildError,
} from '../periodisk-sammanstallning-csv'
import type { PeriodiskSammanstallningReport } from '../periodisk-sammanstallning'

function mkReport(partial: Partial<PeriodiskSammanstallningReport> = {}): PeriodiskSammanstallningReport {
  return {
    period: { type: 'monthly', year: 2025, period: 5, start: '2025-05-01', end: '2025-05-31', label: 'Maj 2025' },
    rows: [],
    warnings: [],
    totals: { services: 0, goods: 0, triangulation: 0, grand: 0, rowCount: 0 },
    reconciliation: { ruta39: null, ruta35: null, ruta38: null, matches: null, tolerance: 1 },
    ...partial,
  }
}

const FILER = {
  organizationNumber: '5560000167',
  contactName: 'Per Persson',
  contactPhone: '0123-45690',
  contactEmail: 'post@filmkopia.se',
}

describe('formatPeriodCode', () => {
  it('monthly: YYMM zero-padded', () => {
    expect(formatPeriodCode('monthly', 2025, 5)).toBe('2505')
    expect(formatPeriodCode('monthly', 2020, 1)).toBe('2001')
    expect(formatPeriodCode('monthly', 2025, 12)).toBe('2512')
  })
  it('quarterly: YY-Q with hyphen', () => {
    expect(formatPeriodCode('quarterly', 2025, 2)).toBe('25-2')
    expect(formatPeriodCode('quarterly', 2022, 4)).toBe('22-4')
  })
  it('throws on invalid month', () => {
    expect(() => formatPeriodCode('monthly', 2025, 13)).toThrow(PsCsvBuildError)
    expect(() => formatPeriodCode('monthly', 2025, 0)).toThrow()
  })
  it('throws on invalid quarter', () => {
    expect(() => formatPeriodCode('quarterly', 2025, 5)).toThrow()
  })
})

describe('buildPeriodiskSammanstallningCsv', () => {
  it('emits SKV574008 header + filer line + rows', () => {
    const report = mkReport({
      rows: [
        { country: 'DE', vatNumber: '123456789', services: 10000, goods: 0, triangulation: 0, customerId: null, customerName: null, hasBlockingIssue: false },
        { country: 'FI', vatNumber: '01409351', services: 0, goods: 5000, triangulation: 0, customerId: null, customerName: null, hasBlockingIssue: false },
      ],
      totals: { services: 10000, goods: 5000, triangulation: 0, grand: 15000, rowCount: 2 },
    })

    const { content } = buildPeriodiskSammanstallningCsv(report, FILER)
    const text = content.toString('latin1')
    const expected =
      'SKV574008;\r\n' +
      '5560000167;2505;Per Persson;0123-45690;post@filmkopia.se\r\n' +
      'DE123456789;10000;;;\r\n' +
      'FI01409351;;5000;;\r\n'
    expect(text).toBe(expected)
  })

  it('emits empty fields rather than zeros', () => {
    const report = mkReport({
      rows: [{ country: 'DE', vatNumber: '123', services: 1000, goods: 0, triangulation: 0, customerId: null, customerName: null, hasBlockingIssue: false }],
      totals: { services: 1000, goods: 0, triangulation: 0, grand: 1000, rowCount: 1 },
    })
    const text = buildPeriodiskSammanstallningCsv(report, FILER).content.toString('latin1')
    expect(text).toContain('DE123;1000;;;')
    expect(text).not.toContain(';0;')
  })

  it('renders negative amounts as signed integers', () => {
    const report = mkReport({
      rows: [{ country: 'DE', vatNumber: '123', services: -1234, goods: 0, triangulation: 0, customerId: null, customerName: null, hasBlockingIssue: false }],
      totals: { services: -1234, goods: 0, triangulation: 0, grand: -1234, rowCount: 1 },
    })
    const text = buildPeriodiskSammanstallningCsv(report, FILER).content.toString('latin1')
    expect(text).toContain('DE123;-1234;;;')
  })

  it('latin1 encoding preserves Swedish characters', () => {
    const report = mkReport()
    const filer = { ...FILER, contactName: 'Åsa Östberg' }
    const { content } = buildPeriodiskSammanstallningCsv(report, filer)
    // Round-trip via latin1.
    const text = content.toString('latin1')
    expect(text).toContain('Åsa Östberg')
    // Confirm bytes are single-byte latin1, not utf-8 (Å in utf-8 is 0xC3 0x85; in latin1 it's 0xC5).
    const aRingByte = content.indexOf(0xC5)
    expect(aRingByte).toBeGreaterThan(0)
  })

  it('refuses to build with blocking errors', () => {
    const report = mkReport({
      warnings: [{ level: 'error', code: 'MISSING_COUNTRY', message: 'oops' }],
    })
    expect(() => buildPeriodiskSammanstallningCsv(report, FILER)).toThrow(PsCsvBuildError)
  })

  it('refuses to build when filer info missing', () => {
    const report = mkReport()
    expect(() =>
      buildPeriodiskSammanstallningCsv(report, { ...FILER, contactEmail: '' }),
    ).toThrow(PsCsvBuildError)
  })

  it('skips rows that round to zero in all buckets', () => {
    const report = mkReport({
      rows: [
        { country: 'DE', vatNumber: '111', services: 100, goods: 0, triangulation: 0, customerId: null, customerName: null, hasBlockingIssue: false },
        { country: 'FR', vatNumber: '222', services: 0, goods: 0, triangulation: 0, customerId: null, customerName: null, hasBlockingIssue: false },
      ],
      totals: { services: 100, goods: 0, triangulation: 0, grand: 100, rowCount: 2 },
    })
    const text = buildPeriodiskSammanstallningCsv(report, FILER).content.toString('latin1')
    expect(text).toContain('DE111')
    expect(text).not.toContain('FR222')
  })

  it('filename uses orgnr + YYMM for monthly', () => {
    const report = mkReport()
    const { filename } = buildPeriodiskSammanstallningCsv(report, FILER)
    expect(filename).toBe('Periodisk_sammanstallning_5560000167_2505.csv')
  })

  it('filename uses orgnr + YYQQ for quarterly', () => {
    const report = mkReport({
      period: { type: 'quarterly', year: 2025, period: 2, start: '2025-04-01', end: '2025-06-30', label: 'Kvartal 2 2025' },
    })
    const { filename } = buildPeriodiskSammanstallningCsv(report, FILER)
    expect(filename).toBe('Periodisk_sammanstallning_5560000167_25Q2.csv')
  })

  it('strips formatting from organization number', () => {
    const { filename, content } = buildPeriodiskSammanstallningCsv(mkReport(), {
      ...FILER,
      organizationNumber: '556000-0167',
    })
    expect(filename).toContain('5560000167')
    expect(content.toString('latin1')).toContain('5560000167;')
  })
})
