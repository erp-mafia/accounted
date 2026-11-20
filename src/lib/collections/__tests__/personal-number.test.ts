import { describe, expect, it } from 'vitest'
import {
  ADULT_AGE,
  normalizeDebtorPersonalNumber,
  PERSONAL_NUMBER_PLACEHOLDER,
  stripPersonalNumbers,
  stripPersonalNumbersDeep,
} from '../personal-number'

const NOW = new Date('2026-10-06T10:00:00Z')
const TODAY = '2026-10-06'

describe('normalizeDebtorPersonalNumber', () => {
  it('keeps a twelve-digit number and ages it', () => {
    expect(normalizeDebtorPersonalNumber('19800101-1231', NOW, TODAY)).toEqual({ status: 'valid', digits: '198001011231', age: 46 })
    expect(normalizeDebtorPersonalNumber('198001011231', NOW, TODAY)).toEqual({ status: 'valid', digits: '198001011231', age: 46 })
  })

  it('gives a ten-digit number with - the century that makes the person at most 99', () => {
    expect(normalizeDebtorPersonalNumber('800101-1231', NOW, TODAY)).toMatchObject({ status: 'valid', digits: '198001011231' })
    expect(normalizeDebtorPersonalNumber('0701011231', NOW, TODAY)).toMatchObject({ status: 'valid', digits: '200701011231', age: 19 })
  })

  it('gives a ten-digit number with + the century before (100 or older)', () => {
    expect(normalizeDebtorPersonalNumber('121212+1212', NOW, TODAY)).toMatchObject({ status: 'valid', digits: '191212121212', age: 113 })
  })

  it('accepts a samordningsnummer and ages it from its real day', () => {
    expect(normalizeDebtorPersonalNumber('800161-1238', NOW, TODAY)).toEqual({ status: 'valid', digits: '198001611238', age: 46 })
  })

  it('refuses a wrong check digit, a date that does not exist and other shapes', () => {
    expect(normalizeDebtorPersonalNumber('800101-1232', NOW, TODAY)).toEqual({ status: 'invalid' })
    expect(normalizeDebtorPersonalNumber('800230-1235', NOW, TODAY)).toEqual({ status: 'invalid' })
    expect(normalizeDebtorPersonalNumber('80-01-01-1231', NOW, TODAY)).toEqual({ status: 'invalid' })
    expect(normalizeDebtorPersonalNumber('5560125790x', NOW, TODAY)).toEqual({ status: 'invalid' })
  })

  it('answers none for nothing stored', () => {
    expect(normalizeDebtorPersonalNumber(null, NOW, TODAY)).toEqual({ status: 'none' })
    expect(normalizeDebtorPersonalNumber('  ', NOW, TODAY)).toEqual({ status: 'none' })
  })

  it('ages on the birthday: 18 on the day, 17 the day before', () => {
    const eighteen = normalizeDebtorPersonalNumber('20081006-1234', NOW, TODAY)
    const seventeen = normalizeDebtorPersonalNumber('20081007-1233', NOW, TODAY)
    expect(eighteen).toMatchObject({ status: 'valid', age: ADULT_AGE })
    expect(seventeen).toMatchObject({ status: 'valid', age: ADULT_AGE - 1 })
    expect(normalizeDebtorPersonalNumber('121212-1212', NOW, TODAY)).toMatchObject({ status: 'valid', age: 13 })
  })
})

describe('stripPersonalNumbers', () => {
  it('replaces anything shaped like a personnummer, in any written form', () => {
    for (const written of ['19800101-1231', '800101-1231', '198001011231', '8001011231', '800101 1231']) {
      expect(stripPersonalNumbers(`Gäldenär ${written} meddelad`)).toBe(`Gäldenär ${PERSONAL_NUMBER_PLACEHOLDER} meddelad`)
    }
  })

  it('leaves org numbers, amounts and longer digit runs alone', () => {
    expect(stripPersonalNumbers('Org 556012-5790, belopp 1250')).toBe('Org 556012-5790, belopp 1250')
    expect(stripPersonalNumbers('OCR 1234567890123')).toBe('OCR 1234567890123')
  })

  it('walks every string of a JSON value', () => {
    expect(
      stripPersonalNumbersDeep({ label: 'Kund 800101-1231', nested: [{ note: '198001011231' }, 5, null], ok: true }),
    ).toEqual({ label: `Kund ${PERSONAL_NUMBER_PLACEHOLDER}`, nested: [{ note: PERSONAL_NUMBER_PLACEHOLDER }, 5, null], ok: true })
  })

  it('strips a personnummer sent as a JSON number, and leaves amounts and org numbers as numbers', () => {
    expect(stripPersonalNumbersDeep({ ssn: 198001011231, short: 8001011231, amount: 1250, org: 5560125790, rate: 12.5 })).toEqual({
      ssn: PERSONAL_NUMBER_PLACEHOLDER,
      short: PERSONAL_NUMBER_PLACEHOLDER,
      amount: 1250,
      org: 5560125790,
      rate: 12.5,
    })
  })
})
