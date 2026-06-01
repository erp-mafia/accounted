import { describe, it, expect } from 'vitest'
import { buildKlp, klpToTxt, type KlpEmployeeRow, type KlpMeta } from '../klp'

const META: KlpMeta = {
  orgNumber: '556063-3517',
  extractionDate: '20260131',
  system: 'gnubok',
  version: '1.0',
  year: 2026,
  month: 1,
}

function row(bucket: KlpEmployeeRow['bucket'], over: Partial<KlpEmployeeRow> = {}): KlpEmployeeRow {
  return {
    bucket,
    baseWage: 0,
    agreedHours: 0,
    workedHours: 0,
    overtimeSupplement: 0,
    overtimeHours: 0,
    variableSupplement: 0,
    sickPay: 0,
    fteShare: 0,
    ...over,
  }
}

describe('buildKlp', () => {
  it('aggregates each bucket independently', () => {
    const rec = buildKlp(META, [
      row('at', { baseWage: 20000, workedHours: 168, sickPay: 1500 }),
      row('at', { baseWage: 10000, workedHours: 80 }),
      row('am', { baseWage: 28000, agreedHours: 172, variableSupplement: 300 }),
      row('tm', { baseWage: 40000, agreedHours: 166, fteShare: 1 }),
      row('tm', { baseWage: 20000, agreedHours: 83, fteShare: 0.5 }),
    ])
    expect(rec.at.count).toBe(2)
    expect(rec.at.baseWage).toBe(30000)
    expect(rec.at.workedHours).toBe(248)
    expect(rec.at.sickPay).toBe(1500)
    expect(rec.am.count).toBe(1)
    expect(rec.am.variableSupplement).toBe(300)
    expect(rec.tm.count).toBe(2)
    expect(rec.tm.fte).toBe(1.5)
  })

  it('rounds the FTE total to two decimals', () => {
    const rec = buildKlp(META, [
      row('tm', { fteShare: 0.333 }),
      row('tm', { fteShare: 0.333 }),
      row('tm', { fteShare: 0.333 }),
    ])
    expect(rec.tm.fte).toBe(1)
  })
})

describe('klpToTxt', () => {
  it('emits header, period and Finns flags', () => {
    const txt = klpToTxt(buildKlp(META, [row('tm', { baseWage: 40000, fteShare: 1 })]))
    expect(txt).toContain('OrgNummer;5560633517') // hyphen stripped to 10 digits
    expect(txt).toContain('UtbManad;202601')
    expect(txt).toContain('Datum;20260131')
    expect(txt).toContain('ATFinns;2') // no hourly workers
    expect(txt).toContain('AMFinns;2')
    expect(txt).toContain('TMTFinns;1') // tjänstemän present
  })

  it('formats the FTE count with a decimal comma (D)', () => {
    const txt = klpToTxt(buildKlp(META, [row('tm', { fteShare: 3.5 })]))
    expect(txt).toContain('TmTrAntH;3,50')
  })

  it('writes integer kronor + hours per bucket', () => {
    const txt = klpToTxt(buildKlp(META, [
      row('at', { baseWage: 20000.4, workedHours: 168, sickPay: 1500 }),
    ]))
    expect(txt).toContain('AtUtbLon;20000')
    expect(txt).toContain('AtArbTim;168')
    expect(txt).toContain('AtSjukLon;1500')
    expect(txt).toContain('AtAnt;1')
  })

  it('emits 0/empty for the fields gnubok does not track', () => {
    const txt = klpToTxt(buildKlp(META, [row('at', { baseWage: 100 })]))
    expect(txt).toContain('AtRetLonS;0')
    expect(txt).toContain('AtRetLonF;')
    expect(txt).toContain('AtTidpLon;0')
    expect(txt).toContain('AtOvtTim;0')
  })

  it('uses semicolon-delimited Name;value lines', () => {
    const txt = klpToTxt(buildKlp(META, []))
    for (const line of txt.split('\n')) {
      expect(line).toMatch(/^[A-Za-z]+;.*$/)
    }
  })
})
