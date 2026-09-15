import { describe, it, expect } from 'vitest'
import { isValidOrgNumber, normalizeAmount, normalizeDate, normalizeOrgNumber, normalizeValue, valuesAgree } from '../fields'

describe('organisation numbers', () => {
  it('keeps ten digits and drops the century of a 12-digit form', () => {
    expect(normalizeOrgNumber('559538-6219')).toBe('5595386219')
    expect(normalizeOrgNumber('16 5595386219')).toBe('5595386219')
    expect(normalizeOrgNumber('55953862')).toBeNull()
    expect(normalizeOrgNumber(5595386219)).toBeNull()
  })

  it('checks the Luhn digit', () => {
    expect(isValidOrgNumber('5595386219')).toBe(true)
    expect(isValidOrgNumber('5595386218')).toBe(false)
    expect(isValidOrgNumber('5560167452')).toBe(false)
    expect(isValidOrgNumber('abc')).toBe(false)
  })
})

describe('normalizeAmount', () => {
  it('reads Swedish formatting', () => {
    expect(normalizeAmount('12 500,50 kr')).toBe(12500.5)
    expect(normalizeAmount('1.250.000')).toBe(1250000)
    expect(normalizeAmount('4 000:-')).toBe(4000)
    expect(normalizeAmount('11,10 %')).toBe(11.1)
    expect(normalizeAmount(1234.567)).toBe(1234.57)
  })

  it('refuses what is not a number', () => {
    expect(normalizeAmount('')).toBeNull()
    expect(normalizeAmount('n/a')).toBeNull()
    expect(normalizeAmount('1,250.00')).toBeNull()
    expect(normalizeAmount(Number.NaN)).toBeNull()
  })
})

describe('normalizeDate', () => {
  it('reads ISO, compact, day-first and Swedish month names', () => {
    expect(normalizeDate('2026-03-01')).toBe('2026-03-01')
    expect(normalizeDate('2026-03-01T00:00:00Z')).toBe('2026-03-01')
    expect(normalizeDate('20260301')).toBe('2026-03-01')
    expect(normalizeDate('1/3/2026')).toBe('2026-03-01')
    expect(normalizeDate('01.03.2026')).toBe('2026-03-01')
    expect(normalizeDate('1 mars 2026')).toBe('2026-03-01')
    expect(normalizeDate('1 okt. 2026')).toBe('2026-10-01')
  })

  it('refuses a partial or impossible date', () => {
    expect(normalizeDate('mars 2026')).toBeNull()
    expect(normalizeDate('2026-02-30')).toBeNull()
  })
})

describe('normalizeValue', () => {
  it('normalizes by kind and refuses what does not fit it', () => {
    expect(normalizeValue('int', '36')).toBe(36)
    expect(normalizeValue('int', '36 månader')).toBeNull()
    expect(normalizeValue('int', '36,5')).toBeNull()
    expect(normalizeValue('enum', ' Yes ')).toBe('yes')
    expect(normalizeValue('text', '  Fastighets  AB ')).toBe('Fastighets AB')
  })
})

describe('valuesAgree', () => {
  it('compares numbers to the öre, text ignoring case and punctuation, everything else exactly', () => {
    expect(valuesAgree('amount', 12500, 12500.001)).toBe(true)
    expect(valuesAgree('amount', 12500, 12500.4)).toBe(false)
    expect(valuesAgree('percent', 11.1, 11.03)).toBe(false)
    expect(valuesAgree('text', 'Almi Företagspartner AB', 'ALMI Företagspartner, AB')).toBe(true)
    expect(valuesAgree('text', 'Kvarnen AB', 'Kvarnen HB')).toBe(false)
    expect(valuesAgree('date', '2026-03-01', '2026-03-02')).toBe(false)
    expect(valuesAgree('orgnr', null, null)).toBe(true)
    expect(valuesAgree('orgnr', '5595386219', null)).toBe(false)
  })
})
