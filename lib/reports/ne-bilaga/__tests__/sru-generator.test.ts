import { describe, it, expect } from 'vitest'
import {
  generateNESRUSubmission,
  validateBlanketterSru,
  getZipFilename,
} from '../sru-generator'
import { encodeISO88591 } from '@/lib/reports/sru-encoding'
import type { NEDeclaration, NEDeclarationRutor } from '../types'

function makeDeclaration(opts: {
  rutor?: Partial<NEDeclarationRutor>
  companyInfo?: Partial<NEDeclaration['companyInfo']>
  fiscalYear?: Partial<NEDeclaration['fiscalYear']>
} = {}): NEDeclaration {
  const rutor: NEDeclarationRutor = {
    R1: 500000, R2: 0, R3: 0, R4: 1200,
    R5: 120000, R6: 80000, R7: 0, R8: 3000,
    R9: 0, R10: 20000, R11: 198200,
    ...opts.rutor,
  }
  const breakdown = Object.fromEntries(
    (Object.keys(rutor) as (keyof NEDeclarationRutor)[]).map((k) => [
      k,
      { accounts: [] as { accountNumber: string; accountName: string; amount: number }[], total: rutor[k] },
    ])
  ) as NEDeclaration['breakdown']

  return {
    fiscalYear: {
      id: 'fp-1',
      name: 'Räkenskapsår 2024',
      start: '2024-01-01',
      end: '2024-12-31',
      isClosed: true,
      ...opts.fiscalYear,
    },
    rutor,
    breakdown,
    companyInfo: {
      companyName: 'Östgöta Träförädling',
      orgNumber: '199001019802',
      addressLine1: 'Storgatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
      email: 'agare@example.se',
      ...opts.companyInfo,
    },
    warnings: [],
  }
}

describe('NE-bilaga SRU generator', () => {
  describe('INFO.SRU', () => {
    it('declares #PRODUKT SRU (never the KU code KONTROLLUPPGIFTER)', () => {
      const { infoSru } = generateNESRUSubmission(makeDeclaration())
      expect(infoSru).toContain('#PRODUKT SRU')
      expect(infoSru).not.toContain('KONTROLLUPPGIFTER')
    })

    it('uses the valid #SKAPAD post (not the legacy #SKAPAT typo)', () => {
      const { infoSru } = generateNESRUSubmission(makeDeclaration())
      expect(infoSru).toMatch(/#SKAPAD \d{8} \d{6}/)
      expect(infoSru).not.toContain('#SKAPAT')
    })

    it('has the DATABESKRIVNING + MEDIELEV blocks with mandatory posts', () => {
      const { infoSru } = generateNESRUSubmission(makeDeclaration())
      expect(infoSru).toContain('#DATABESKRIVNING_START')
      expect(infoSru).toContain('#FILNAMN BLANKETTER.SRU')
      expect(infoSru).toContain('#DATABESKRIVNING_SLUT')
      expect(infoSru).toContain('#MEDIELEV_START')
      expect(infoSru).toContain('#ORGNR 199001019802')
      expect(infoSru).toContain('#NAMN Östgöta Träförädling')
      expect(infoSru).toContain('#POSTNR 11122')
      expect(infoSru).toContain('#POSTORT Stockholm')
      expect(infoSru).toContain('#MEDIELEV_SLUT')
    })
  })

  describe('BLANKETTER.SRU', () => {
    it('emits a single NE blankett block terminated by #FIL_SLUT', () => {
      const { blanketterSru } = generateNESRUSubmission(makeDeclaration())
      expect(blanketterSru).toMatch(/#BLANKETT NE-2024P4/)
      expect(blanketterSru).toMatch(/#IDENTITET 199001019802 \d{8} \d{6}/)
      expect(blanketterSru).toContain('#NAMN Östgöta Träförädling')
      expect(blanketterSru).toContain('#BLANKETTSLUT')
      expect(blanketterSru).toContain('#FIL_SLUT')
    })

    it('emits the fiscal-year date fields 7011/7012', () => {
      const { blanketterSru } = generateNESRUSubmission(makeDeclaration())
      expect(blanketterSru).toContain('#UPPGIFT 7011 20240101')
      expect(blanketterSru).toContain('#UPPGIFT 7012 20241231')
    })

    it('maps each ruta to the authoritative BAS field code', () => {
      const { blanketterSru } = generateNESRUSubmission(makeDeclaration())
      expect(blanketterSru).toContain('#UPPGIFT 7400 500000') // R1
      expect(blanketterSru).toContain('#UPPGIFT 7403 1200')   // R4
      expect(blanketterSru).toContain('#UPPGIFT 7500 120000') // R5
      expect(blanketterSru).toContain('#UPPGIFT 7501 80000')  // R6
      expect(blanketterSru).toContain('#UPPGIFT 7503 3000')   // R8
      expect(blanketterSru).toContain('#UPPGIFT 7505 20000')  // R10
      expect(blanketterSru).toContain('#UPPGIFT 7440 198200') // R11
    })

    it('does not use the old (wrong) 73xx field codes', () => {
      const { blanketterSru } = generateNESRUSubmission(makeDeclaration())
      expect(blanketterSru).not.toContain('7310')
      expect(blanketterSru).not.toContain('7350')
      expect(blanketterSru).not.toContain('#UPPGIFT 7000')
    })

    it('omits #UPPGIFT lines for zero-value rutor', () => {
      const { blanketterSru } = generateNESRUSubmission(makeDeclaration())
      // R2/R3/R7/R9 are 0 in the fixture
      expect(blanketterSru).not.toContain('#UPPGIFT 7401')
      expect(blanketterSru).not.toContain('#UPPGIFT 7402')
      expect(blanketterSru).not.toContain('#UPPGIFT 7502')
      expect(blanketterSru).not.toContain('#UPPGIFT 7504')
    })

    it('renders a negative result (loss) with a minus sign', () => {
      const { blanketterSru } = generateNESRUSubmission(makeDeclaration({ rutor: { R11: -5000 } }))
      expect(blanketterSru).toContain('#UPPGIFT 7440 -5000')
    })
  })

  describe('identity normalization (enskild firma personnummer)', () => {
    it('passes a 12-digit personnummer through unchanged (no "16" prefix)', () => {
      const { infoSru } = generateNESRUSubmission(
        makeDeclaration({ companyInfo: { orgNumber: '19900101-9802' } })
      )
      expect(infoSru).toContain('#ORGNR 199001019802')
      expect(infoSru).not.toContain('#ORGNR 16')
    })

    it('expands a 10-digit personnummer to 12 digits with a birth century', () => {
      const { infoSru } = generateNESRUSubmission(
        makeDeclaration({ companyInfo: { orgNumber: '900101-9802' } })
      )
      expect(infoSru).toContain('#ORGNR 199001019802')
    })

    it('infers 1900s for a 10-digit yy that would map to a child in the 2000s', () => {
      // yy=24 for income year 2024: naive yy<=24 → 2024 (age 0); adult-age logic must pick 1924.
      const { infoSru } = generateNESRUSubmission(
        makeDeclaration({ companyInfo: { orgNumber: '2401019808' } })
      )
      expect(infoSru).toContain('#ORGNR 192401019808')
    })
  })

  describe('identity validation (no silent placeholder file)', () => {
    it('throws when the personnummer is missing', () => {
      expect(() =>
        generateNESRUSubmission(makeDeclaration({ companyInfo: { orgNumber: null } }))
      ).toThrow(/personnummer/i)
    })

    it('throws when the identity has an unexpected length', () => {
      expect(() =>
        generateNESRUSubmission(makeDeclaration({ companyInfo: { orgNumber: '12345' } }))
      ).toThrow(/personnummer/i)
    })
  })

  describe('validateBlanketterSru', () => {
    it('passes on generated output', () => {
      const { blanketterSru } = generateNESRUSubmission(makeDeclaration())
      const result = validateBlanketterSru(blanketterSru)
      expect(result.isValid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('fails when #FIL_SLUT is missing', () => {
      const { blanketterSru } = generateNESRUSubmission(makeDeclaration())
      const result = validateBlanketterSru(blanketterSru.replace('#FIL_SLUT', ''))
      expect(result.isValid).toBe(false)
      expect(result.errors).toContain('Missing #FIL_SLUT terminator')
    })

    it('fails when the mandatory fiscal-year date field (7011) is missing', () => {
      const { blanketterSru } = generateNESRUSubmission(makeDeclaration())
      const result = validateBlanketterSru(blanketterSru.replace(/#UPPGIFT 7011 \d+\r?\n/, ''))
      expect(result.isValid).toBe(false)
      expect(result.errors.some((e) => e.includes('7011'))).toBe(true)
    })
  })

  describe('ISO 8859-1 encoding', () => {
    it('encodes å/ä/ö as Latin-1 bytes, not UTF-8 and not "?"', () => {
      const { infoSru } = generateNESRUSubmission(makeDeclaration())
      const bytes = encodeISO88591(infoSru)
      // Östgöta → Ö=0xD6, ä not here; check å(0xE5) ä(0xE4) ö(0xF6) present for "Östgöta"
      expect(Array.from(bytes)).toContain(0xd6) // Ö
      expect(Array.from(bytes)).toContain(0xf6) // ö
      // No replacement char and no UTF-8 lead byte 0xC3 for these chars
      expect(Array.from(bytes)).not.toContain(0x3f) // '?'
      expect(Array.from(bytes)).not.toContain(0xc3) // UTF-8 lead byte
    })
  })

  describe('getZipFilename', () => {
    it('produces NE_SRU_<id>_<year>.zip', () => {
      expect(getZipFilename(makeDeclaration())).toBe('NE_SRU_199001019802_2024.zip')
    })

    it('uses the income year (fiscal year end) for a broken fiscal year', () => {
      expect(
        getZipFilename(makeDeclaration({ fiscalYear: { start: '2024-05-01', end: '2025-04-30' } }))
      ).toBe('NE_SRU_199001019802_2025.zip')
    })
  })
})
