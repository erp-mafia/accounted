import { describe, it, expect } from 'vitest'
import { maskPersonnummerInText } from '../personnummer-format'

describe('maskPersonnummerInText', () => {
  it('masks a 12-digit personnummer with or without a separator', () => {
    expect(maskPersonnummerInText('Fel för 190001010000.')).toBe('Fel för 19000101-XXXX.')
    expect(maskPersonnummerInText('Fel för 19000101-0000')).toBe('Fel för 19000101-XXXX')
    expect(maskPersonnummerInText('Fel för 19000101+0000')).toBe('Fel för 19000101-XXXX')
  })

  it('masks a samordningsnummer (day + 60)', () => {
    expect(maskPersonnummerInText('id 190001610000')).toBe('id 19000161-XXXX')
  })

  it('masks every occurrence', () => {
    expect(maskPersonnummerInText('190001010000 och 200012310000')).toBe('19000101-XXXX och 20001231-XXXX')
  })

  it('leaves an employer id, an amount and a longer digit run alone', () => {
    expect(maskPersonnummerInText('Arbetsgivare 165560000000')).toBe('Arbetsgivare 165560000000')
    expect(maskPersonnummerInText('Belopp 1000000')).toBe('Belopp 1000000')
    expect(maskPersonnummerInText('Referens 11900010100001')).toBe('Referens 11900010100001')
  })

  it('leaves a date-like run with an impossible month alone', () => {
    expect(maskPersonnummerInText('199013010000')).toBe('199013010000')
  })

  it('masks a 12-digit personnummer with a space before the last four digits', () => {
    expect(maskPersonnummerInText('Fel för 19000101 0000.')).toBe('Fel för 19000101-XXXX.')
  })

  it('masks the 10-digit forms, keeping YYMMDD', () => {
    expect(maskPersonnummerInText('Fel för 000101-0000.')).toBe('Fel för 000101-XXXX.')
    expect(maskPersonnummerInText('Fel för 000101+0000')).toBe('Fel för 000101-XXXX')
    expect(maskPersonnummerInText('Fel för 0001010000')).toBe('Fel för 000101-XXXX')
    expect(maskPersonnummerInText('samordningsnummer 000161-0000')).toBe('samordningsnummer 000161-XXXX')
  })

  it('leaves organisationsnummer alone in both forms (third digit 2 or more)', () => {
    expect(maskPersonnummerInText('Org 556000-0000 och 5560000000')).toBe('Org 556000-0000 och 5560000000')
    expect(maskPersonnummerInText('Arbetsgivare 165560000000')).toBe('Arbetsgivare 165560000000')
  })

  it('never re-masks or half-masks an already masked value', () => {
    expect(maskPersonnummerInText('19000101-XXXX')).toBe('19000101-XXXX')
    expect(maskPersonnummerInText(maskPersonnummerInText('190001010000'))).toBe('19000101-XXXX')
  })
})
