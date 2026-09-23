import { describe, it, expect } from 'vitest'
import { rutorToMomsuppgift, formatRedovisare, formatRedovisningsperiod } from '../lib/mappers'
import type { VatDeclarationRutor } from '@/types'

const emptyRutor: VatDeclarationRutor = {
  ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
  ruta10: 0, ruta11: 0, ruta12: 0,
  ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
  ruta30: 0, ruta31: 0, ruta32: 0,
  ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
  ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
  ruta48: 0, ruta49: 0,
  ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
}

describe('rutorToMomsuppgift', () => {
  it('converts typical EF VAT declaration', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta05: 10000,
      ruta10: 2500,
      ruta48: 350,
      ruta49: 2150,
    }

    const result = rutorToMomsuppgift(rutor)

    expect(result.momspliktigForsaljning).toBe(10000)
    expect(result.momsForsaljningUtgaendeHog).toBe(2500)
    expect(result.ingaendeMomsAvdrag).toBe(350)
    expect(result.summaMoms).toBe(2150)
  })

  it('omits zero-value fields except summaMoms', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta05: 5000,
      ruta10: 1250,
      ruta49: 1250,
    }

    const result = rutorToMomsuppgift(rutor)

    expect(result.momspliktigForsaljning).toBe(5000)
    expect(result.momsForsaljningUtgaendeHog).toBe(1250)
    expect(result.summaMoms).toBe(1250)
    // Zero fields should not be present
    expect(result.momspliktigaUttag).toBeUndefined()
    expect(result.momsForsaljningUtgaendeMedel).toBeUndefined()
    expect(result.momsForsaljningUtgaendeLag).toBeUndefined()
    expect(result.ingaendeMomsAvdrag).toBeUndefined()
  })

  it('always includes summaMoms even when zero', () => {
    const result = rutorToMomsuppgift(emptyRutor)
    expect(result.summaMoms).toBe(0)
  })

  it('maps reverse charge fields correctly', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta21: 5000,
      ruta30: 1250,
      ruta48: 1250,
      ruta49: 0,
    }

    const result = rutorToMomsuppgift(rutor)

    expect(result.inkopTjansterEU).toBe(5000)
    expect(result.momsInkopUtgaendeHog).toBe(1250)
    expect(result.ingaendeMomsAvdrag).toBe(1250)
    expect(result.summaMoms).toBe(0)
  })

  it('maps EU/export and import fields', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta35: 8000,
      ruta36: 12000,
      ruta39: 3000,
      ruta40: 5000,
      ruta50: 2000,
      ruta60: 500,
      ruta49: 500,
    }

    const result = rutorToMomsuppgift(rutor)

    expect(result.forsaljningVarorEU).toBe(8000)
    expect(result.forsaljningVarorUtanforEU).toBe(12000)
    expect(result.forsaljningTjansterEU).toBe(3000)
    expect(result.ovrigForsaljningTjansterUtanforSE).toBe(5000)
    expect(result.import).toBe(2000)
    expect(result.momsImportUtgaendeHog).toBe(500)
  })

  // FK009 regression: SKV recomputes summaMoms from rounded rutor and
  // compares against ours. If we round ruta49 from unrounded inputs while
  // rounding each ruta independently we drift by ±1 SEK per fractional ruta.
  it('summaMoms equals Σ(rounded output VAT rutor) - rounded ruta48', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      // Fractional öres on every VAT-amount ruta so banker's rounding can
      // disagree between the orundad ruta49 and the rundade individual fält.
      ruta10: 100.49,
      ruta11: 50.51,
      ruta12: 25.49,
      ruta30: 10.51,
      ruta31: 5.49,
      ruta32: 2.51,
      ruta60: 7.49,
      ruta61: 3.51,
      ruta62: 1.49,
      ruta48: 80.51,
      ruta49: 100.49 + 50.51 + 25.49 + 10.51 + 5.49 + 2.51 + 7.49 + 3.51 + 1.49 - 80.51,
    }

    const result = rutorToMomsuppgift(rutor)

    const expectedSumma =
      (result.momsForsaljningUtgaendeHog ?? 0) +
      (result.momsForsaljningUtgaendeMedel ?? 0) +
      (result.momsForsaljningUtgaendeLag ?? 0) +
      (result.momsInkopUtgaendeHog ?? 0) +
      (result.momsInkopUtgaendeMedel ?? 0) +
      (result.momsInkopUtgaendeLag ?? 0) +
      (result.momsImportUtgaendeHog ?? 0) +
      (result.momsImportUtgaendeMedel ?? 0) +
      (result.momsImportUtgaendeLag ?? 0) -
      (result.ingaendeMomsAvdrag ?? 0)

    expect(result.summaMoms).toBe(expectedSumma)
    // Sanity-check: result is an integer (SKV requires whole kronor)
    expect(Number.isInteger(result.summaMoms)).toBe(true)
  })

  it('summaMoms is negative when input VAT exceeds output VAT', () => {
    const rutor: VatDeclarationRutor = {
      ...emptyRutor,
      ruta48: 5000,
      ruta49: -5000,
    }

    const result = rutorToMomsuppgift(rutor)
    expect(result.summaMoms).toBe(-5000)
  })
})

describe('formatRedovisare', () => {
  it('formats aktiebolag org number with 16 prefix', () => {
    expect(formatRedovisare('5020000013', 'aktiebolag')).toBe('165020000013')
  })

  it('formats aktiebolag org number with hyphen', () => {
    expect(formatRedovisare('502000-0013', 'aktiebolag')).toBe('165020000013')
  })

  it('formats enskild firma personnummer with 19 prefix for older', () => {
    // Person born in 1985: 85 > 26 (current year), so prefix 19
    expect(formatRedovisare('8501011234', 'enskild_firma')).toBe('198501011234')
  })

  it('formats enskild firma personnummer with 20 prefix for younger', () => {
    // Person born in 2005: 05 < 26 (current year), so prefix 20
    expect(formatRedovisare('0501011234', 'enskild_firma')).toBe('200501011234')
  })

  it('passes through 12-digit numbers unchanged', () => {
    expect(formatRedovisare('165020000013', 'aktiebolag')).toBe('165020000013')
  })

  it('throws for invalid length', () => {
    expect(() => formatRedovisare('12345', 'aktiebolag')).toThrow('Ogiltigt organisationsnummer')
  })
})

describe('formatRedovisningsperiod', () => {
  it('formats monthly period as YYYYMM', () => {
    expect(formatRedovisningsperiod('monthly', 2025, 1)).toBe('202501')
    expect(formatRedovisningsperiod('monthly', 2025, 12)).toBe('202512')
  })

  it('formats quarterly period as last month of quarter', () => {
    expect(formatRedovisningsperiod('quarterly', 2025, 1)).toBe('202503')
    expect(formatRedovisningsperiod('quarterly', 2025, 2)).toBe('202506')
    expect(formatRedovisningsperiod('quarterly', 2025, 3)).toBe('202509')
    expect(formatRedovisningsperiod('quarterly', 2025, 4)).toBe('202512')
  })

  it('formats yearly period as December', () => {
    expect(formatRedovisningsperiod('yearly', 2025, 1)).toBe('202512')
  })
})
