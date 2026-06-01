import { describe, it, expect } from 'vitest'
import { groupSickCases, buildSusRecord, buildSusFile, formatPeOrgNr, type SusSickDay } from '../sus'

const days = (pnr: string, ...dates: string[]): SusSickDay[] => dates.map(date => ({ personnummer: pnr, date }))

describe('formatPeOrgNr', () => {
  it('prefixes 16 and keeps 10 org digits', () => {
    expect(formatPeOrgNr('556500-0000')).toBe('165565000000')
    expect(formatPeOrgNr('5565000000')).toBe('165565000000')
  })
})

describe('groupSickCases', () => {
  it('groups consecutive sick days into one case', () => {
    const cases = groupSickCases(days('197610030000', '2024-01-08', '2024-01-09', '2024-01-10'), '2024-01-01', '2024-01-31')
    expect(cases).toHaveLength(1)
    expect(cases[0]).toMatchObject({ sjukFrom: '2024-01-08', sjukTom: '2024-01-10', ersDays: 3 })
  })

  it('bridges weekend gaps within a single case', () => {
    // Fri 2024-01-05 … Mon 2024-01-08 (Sat/Sun not marked) → one case.
    const cases = groupSickCases(days('1', '2024-01-05', '2024-01-08'), '2024-01-01', '2024-01-31')
    expect(cases).toHaveLength(1)
    expect(cases[0].ersDays).toBe(2)
  })

  it('splits genuinely separate cases', () => {
    const cases = groupSickCases(days('1', '2024-01-03', '2024-01-20', '2024-01-21'), '2024-01-01', '2024-01-31')
    expect(cases).toHaveLength(2)
  })

  it('clamps SjukFrom to the month start when the case began earlier', () => {
    // Case starts 2024-01-30, continues into February — querying February with
    // a lookback sees the January tail.
    const cases = groupSickCases(
      days('1', '2024-01-30', '2024-01-31', '2024-02-01', '2024-02-02'),
      '2024-02-01', '2024-02-29',
    )
    expect(cases).toHaveLength(1)
    expect(cases[0].sjukFrom).toBe('2024-02-01') // clamped to month start
    expect(cases[0].sjukTom).toBe('2024-02-02')
    expect(cases[0].ersDays).toBe(2) // only Feb days counted
  })

  it('drops cases entirely outside the month', () => {
    const cases = groupSickCases(days('1', '2023-12-28', '2023-12-29'), '2024-01-01', '2024-01-31')
    expect(cases).toHaveLength(0)
  })

  it('caps AntErsDagar at 14', () => {
    const longRun = Array.from({ length: 20 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}`)
    const cases = groupSickCases(days('1', ...longRun), '2024-01-01', '2024-01-31')
    expect(cases[0].ersDays).toBe(14)
  })
})

describe('buildSusRecord', () => {
  it('produces a 42-char fixed record', () => {
    const rec = buildSusRecord(
      { orgNumber: '556500-0000' },
      { personnummer: '197610030000', sjukFrom: '2024-01-08', sjukTom: '2024-01-08', ersDays: 1 },
    )
    expect(rec).toHaveLength(42)
    expect(rec.slice(0, 12)).toBe('165565000000') // PeOrgNr
    expect(rec.slice(12, 24)).toBe('197610030000') // PersonNr
    expect(rec.slice(24, 32)).toBe('20240108')     // SjukFrom
    expect(rec.slice(32, 40)).toBe('20240108')     // SjukTom
    expect(rec.slice(40, 42)).toBe('01')           // AntErsDagar zero-padded
  })
})

describe('buildSusFile', () => {
  it('joins one record per case', () => {
    const result = buildSusFile({ orgNumber: '5565000000' }, [
      { personnummer: '197610030000', sjukFrom: '2024-01-08', sjukTom: '2024-01-10', ersDays: 3 },
      { personnummer: '198001011234', sjukFrom: '2024-01-15', sjukTom: '2024-01-16', ersDays: 2 },
    ])
    expect(result.recordCount).toBe(2)
    expect(result.content.split('\n')).toHaveLength(2)
    for (const line of result.content.split('\n')) expect(line).toHaveLength(42)
  })

  it('emits only the org number when there are no sick cases', () => {
    const result = buildSusFile({ orgNumber: '556500-0000' }, [])
    expect(result.recordCount).toBe(0)
    expect(result.content).toBe('165565000000')
  })
})
