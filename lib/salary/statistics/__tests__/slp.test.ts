import { describe, it, expect } from 'vitest'
import { buildSlpRecord, buildSlpFile, type SlpEmployeeInput, type SlpMeta } from '../slp'

const baseEmp: SlpEmployeeInput = {
  personnummer: '199001011234',
  workerCategory: 'tjansteman',
  salaryType: 'monthly',
  ssykCode: '2611',
  cfarNumber: '12345678',
  arbetstidsart: '1',
  anstallningsform: '1',
  agreedWage: 23756,
  workedHours: 1600,
  overtimeSupplement: 0,
  vacationDays: 25,
}

const scbMeta: SlpMeta = { year: 2025, orgNumber: '556677-8899', variant: 'scb' }

describe('buildSlpRecord — fixed part', () => {
  it('is exactly 300 characters', () => {
    expect(buildSlpRecord(scbMeta, baseEmp)).toHaveLength(300)
  })

  it('places period, org-nr, personnummer at their fixed positions', () => {
    const rec = buildSlpRecord(scbMeta, baseEmp)
    expect(rec.slice(0, 4)).toBe('2025')          // pos 1–4 period
    expect(rec.slice(14, 24)).toBe('5566778899')  // pos 15–24 org-nr (hyphen stripped)
    expect(rec.slice(29, 41)).toBe('199001011234') // pos 30–41 personnummer
  })

  it('zero-fills SN-only fields for the SCB variant', () => {
    const rec = buildSlpRecord(scbMeta, baseEmp)
    expect(rec.slice(4, 11)).toBe('0000000')  // delägarnummer
    expect(rec.slice(11, 14)).toBe('000')     // arbetsplatsnummer
    expect(rec.slice(24, 26)).toBe('00')      // förbundsnummer
  })

  it('encodes personalkategori, löneform, SSYK and CFAR', () => {
    const rec = buildSlpRecord(scbMeta, baseEmp)
    expect(rec[41]).toBe('2')                  // pos 42 personalkategori: tjänsteman → 2
    expect(rec.slice(43, 47)).toBe('2611')     // pos 44–47 SSYK
    expect(rec[49]).toBe('1')                  // pos 50 löneform: monthly → 1
    expect(rec.slice(55, 63)).toBe('12345678') // pos 56–63 CFAR
  })
})

describe('buildSlpRecord — variable part (styrkod+värde)', () => {
  it('emits 051 wage in whole kronor for monthly', () => {
    const rec = buildSlpRecord(scbMeta, baseEmp)
    const variable = rec.slice(70)
    expect(variable.startsWith('051' + '0023756')).toBe(true)
  })

  it('emits 051 wage with 2 implied decimals for hourly', () => {
    const rec = buildSlpRecord(scbMeta, { ...baseEmp, salaryType: 'hourly', agreedWage: 75.5 })
    const variable = rec.slice(70)
    expect(variable.startsWith('051' + '0007550')).toBe(true) // 75,50 → 0007550
    expect(rec[49]).toBe('2') // löneform hourly → 2
  })

  it('includes 001 worked time, 600 vacation days and 700 anställningsform', () => {
    const variable = buildSlpRecord(scbMeta, baseEmp).slice(70)
    expect(variable).toContain('001' + '0001600')
    expect(variable).toContain('600' + '0000025')
    expect(variable).toContain('700' + '0000001')
  })
})

describe('buildSlpRecord — SN variant', () => {
  it('fills SN organisation codes', () => {
    const rec = buildSlpRecord(
      { year: 2025, orgNumber: '556677-8899', variant: 'sn', sn: { delagarnummer: '1234567', forbundsnummer: '12' } },
      baseEmp,
    )
    expect(rec.slice(4, 11)).toBe('1234567') // delägarnummer
    expect(rec.slice(24, 26)).toBe('12')     // förbundsnummer
  })
})

describe('buildSlpFile', () => {
  it('produces one line per employee and counts incomplete rows', () => {
    const result = buildSlpFile(scbMeta, [
      baseEmp,
      { ...baseEmp, ssykCode: null }, // missing SSYK → incomplete
    ])
    expect(result.recordCount).toBe(2)
    expect(result.content.split('\n')).toHaveLength(2)
    expect(result.incompleteCount).toBe(1)
  })

  it('every line is 300 chars', () => {
    const result = buildSlpFile(scbMeta, [baseEmp, { ...baseEmp, salaryType: 'hourly', agreedWage: 200 }])
    for (const line of result.content.split('\n')) {
      expect(line).toHaveLength(300)
    }
  })
})
