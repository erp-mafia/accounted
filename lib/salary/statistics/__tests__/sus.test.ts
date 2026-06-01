import { describe, it, expect } from 'vitest'
import { groupSickCases, buildSusRecord, buildSusFile, formatPeOrgNr, type SusSickDay } from '../sus'

const days = (pnr: string, ...dates: string[]): SusSickDay[] => dates.map(date => ({ personnummer: pnr, date }))

describe('formatPeOrgNr', () => {
  it('prefixes 16 and keeps 10 org digits for orgnr holders (AB)', () => {
    expect(formatPeOrgNr('556500-0000')).toBe('165565000000')
    expect(formatPeOrgNr('5565000000')).toBe('165565000000')
  })

  it('treats an aktiebolag identifier as an orgnr even when entityType is set', () => {
    // Real orgnr — month field (positions 3–4) is ≥ 20, so never a personnummer.
    expect(formatPeOrgNr('556500-0000', { entityType: 'aktiebolag' })).toBe('165565000000')
  })

  it('uses century + personnummer for an enskild firma identified by a 12-digit pnr', () => {
    expect(formatPeOrgNr('19771003-0000', { entityType: 'enskild_firma' })).toBe('197710030000')
  })

  it('infers the century for an enskild firma 10-digit personnummer', () => {
    // yy=77 → 2077 is after the 2024 reference, so 19xx.
    expect(formatPeOrgNr('7710030000', { entityType: 'enskild_firma', referenceYear: 2024 })).toBe('197710030000')
    // yy=05 → 2005 ≤ 2024, so 20xx.
    expect(formatPeOrgNr('0510030000', { entityType: 'enskild_firma', referenceYear: 2024 })).toBe('200510030000')
  })

  it('still uses the 16-prefix for an enskild firma that holds a special orgnr', () => {
    // Special orgnr (month field ≥ 20) is not a personnummer → orgnr path.
    expect(formatPeOrgNr('969500-0000', { entityType: 'enskild_firma' })).toBe('169695000000')
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

  it('caps SjukTom and AntErsDagar to the 14-day sjuklöneperiod (same month)', () => {
    // Illness Jan 1–20: the sjuklöneperiod ends 14 days after onset (Jan 14),
    // so SjukTom must be Jan 14, not the last recorded day (Jan 20).
    const longRun = Array.from({ length: 20 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}`)
    const cases = groupSickCases(days('1', ...longRun), '2024-01-01', '2024-01-31')
    expect(cases[0].sjukFrom).toBe('2024-01-01')
    expect(cases[0].sjukTom).toBe('2024-01-14')
    expect(cases[0].ersDays).toBe(14)
  })

  it('expires SjukTom mid-month when the sjuklöneperiod ran out in the lookback', () => {
    // Illness starts Dec 25 2023 and continues; querying January 2024 with a
    // lookback. The 14-day period ends Jan 7 (Dec 25 + 13 days), so SjukTom must
    // be Jan 7 and ersDays 7 — not Jan 20 / 14 from the raw in-month tail.
    const dec = Array.from({ length: 7 }, (_, i) => `2023-12-${25 + i}`)
    const jan = Array.from({ length: 20 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}`)
    const cases = groupSickCases(days('1', ...dec, ...jan), '2024-01-01', '2024-01-31')
    expect(cases).toHaveLength(1)
    expect(cases[0]).toMatchObject({ sjukFrom: '2024-01-01', sjukTom: '2024-01-07', ersDays: 7 })
  })

})

// SCB's own worked example (datafilbeskrivning, p.4): Kalle is sick 23 Jan – 2
// Feb 2024, hourly, NOT scheduled Fri–Sun. The case is split across two monthly
// files. Paid (scheduled) sick days are Mon–Thu; weekends are not paid.
describe('groupSickCases — SCB cross-month worked example', () => {
  const PNR = '197788888888'
  const janPaid = ['2024-01-23', '2024-01-24', '2024-01-25', '2024-01-26', '2024-01-30', '2024-01-31']
  const febPaid = ['2024-02-01', '2024-02-02']

  it('January file → SjukFrom 23 Jan, SjukTom 31 Jan (month end), AntErsDagar 06', () => {
    // collectSusCases(jan) queries [Dec 25 … Jan 31]; only the Jan paid days match.
    const [c] = groupSickCases(days(PNR, ...janPaid), '2024-01-01', '2024-01-31')
    expect(c).toMatchObject({ sjukFrom: '2024-01-23', sjukTom: '2024-01-31', ersDays: 6 })
  })

  it('February file → SjukFrom 01 Feb (clamped), SjukTom 02 Feb, AntErsDagar 02', () => {
    // collectSusCases(feb) queries [Jan 25 … Feb 29]; the 7-day lookback ties the
    // late-January tail to the February portion of the same sjukfall.
    const lookback = ['2024-01-25', '2024-01-26', '2024-01-30', '2024-01-31']
    const [c] = groupSickCases(days(PNR, ...lookback, ...febPaid), '2024-02-01', '2024-02-29')
    expect(c).toMatchObject({ sjukFrom: '2024-02-01', sjukTom: '2024-02-02', ersDays: 2 })
  })

  it('AntErsDagar counts paid days, which may be fewer than the SjukFrom–SjukTom span', () => {
    // Spec example: span 23→31 Jan = 9 calendar days, but only 6 paid days.
    const [c] = groupSickCases(days(PNR, ...janPaid), '2024-01-01', '2024-01-31')
    const span = (Date.UTC(2024, 0, 31) - Date.UTC(2024, 0, 23)) / 86_400_000 + 1
    expect(span).toBe(9)
    expect(c.ersDays).toBe(6)
    expect(c.ersDays).toBeLessThanOrEqual(14)
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
