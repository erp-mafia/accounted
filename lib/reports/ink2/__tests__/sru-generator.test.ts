import { describe, it, expect } from 'vitest'
import {
  generateSRUSubmission,
  validateBlanketterSru,
  getZipFilename,
} from '../sru-generator'
import type { INK2Declaration } from '../types'

function makeDeclaration(overrides?: Partial<INK2Declaration>): INK2Declaration {
  const defaultInk2r = {
    '7201': 0, '7202': 0, '7214': 0, '7215': 50000, '7216': 0, '7217': 0,
    '7230': 0, '7231': 0, '7233': 0, '7232': 0, '7234': 0, '7235': 0,
    '7241': 0, '7242': 0, '7243': 0, '7244': 0, '7245': 0, '7246': 0,
    '7251': 25000, '7252': 0, '7261': 0, '7262': 0, '7263': 0,
    '7270': 0, '7271': 0, '7281': 100000,
    '7301': 50000, '7302': 20000,
    '7321': 0, '7322': 0, '7323': 0,
    '7331': 0, '7332': 0, '7333': 0,
    '7350': 0, '7351': 0, '7352': 0, '7353': 0, '7354': 0,
    '7360': 0, '7361': 0, '7362': 0, '7363': 0, '7364': 0,
    '7365': 30000, '7366': 0, '7367': 0, '7369': 70000, '7368': 0, '7370': 0,
    '7410': 500000, '7411': 0, '7412': 0, '7413': 0,
    '7511': 0, '7512': 0, '7513': 100000, '7514': 80000, '7515': 10000, '7516': 0, '7517': 5000,
    '7414': 0, '7415': 0, '7423': 0, '7416': 0, '7417': 0,
    '7521': 0, '7522': 3000,
    '7524': 0, '7419': 0, '7420': 0, '7525': 0, '7421': 0, '7422': 0,
    '7528': 0,
    '7450': 302000, '7550': 0,
  } as INK2Declaration['ink2r']

  return {
    fiscalYear: {
      id: 'period-1',
      name: 'Räkenskapsår 2025',
      start: '2025-01-01',
      end: '2025-12-31',
      isClosed: true,
    },
    ink2: {
      '7011': '20250101',
      '7012': '20251231',
      '7104': 302000,
      '7114': 0,
    },
    ink2r: defaultInk2r,
    ink2s: {
      '7011': '20250101',
      '7012': '20251231',
      '7650': 302000,
      '7750': 0,
      '7651': 0,
      '7653': 0,
      '7754': 0,
      '8020': 302000,
      '8021': 0,
    },
    breakdown: {} as INK2Declaration['breakdown'],
    totals: {
      totalAssets: 175000,
      totalEquityLiabilities: 175000,
      operatingResult: 305000,
      aretsResultat: 302000,
    },
    companyInfo: {
      companyName: 'Test AB',
      orgNumber: '556677-8899',
      addressLine1: 'Testgatan 1',
      postalCode: '11122',
      city: 'Stockholm',
      email: 'test@example.com',
    },
    warnings: [],
    ...overrides,
  }
}

describe('INK2 SRU Generator', () => {
  describe('generateSRUSubmission', () => {
    it('produces valid INFO.SRU', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)

      expect(submission.infoSru).toContain('#DATABESKRIVNING_START')
      expect(submission.infoSru).toContain('#PRODUKT SRU')
      expect(submission.infoSru).toContain('#FILNAMN BLANKETTER.SRU')
      expect(submission.infoSru).toContain('#DATABESKRIVNING_SLUT')
      expect(submission.infoSru).toContain('#MEDIELEV_START')
      expect(submission.infoSru).toContain('#ORGNR 165566778899')
      expect(submission.infoSru).toContain('#NAMN Test AB')
      expect(submission.infoSru).toContain('#POSTNR 11122')
      expect(submission.infoSru).toContain('#POSTORT Stockholm')
      expect(submission.infoSru).toContain('#MEDIELEV_SLUT')
    })

    it('formats org number as 12-digit with century prefix 16', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)

      // In INFO.SRU
      expect(submission.infoSru).toContain('#ORGNR 165566778899')
      // In BLANKETTER.SRU
      expect(submission.blanketterSru).toContain('#IDENTITET 165566778899')
    })

    it('handles org number already in 12-digit format', () => {
      const declaration = makeDeclaration({
        companyInfo: {
          companyName: 'Test AB',
          orgNumber: '165566778899',
          addressLine1: null,
          postalCode: '11122',
          city: 'Stockholm',
          email: null,
        },
      })
      const submission = generateSRUSubmission(declaration)
      expect(submission.infoSru).toContain('#ORGNR 165566778899')
    })

    it('produces three blankett blocks in BLANKETTER.SRU', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)

      expect(submission.blanketterSru).toContain('#BLANKETT INK2-2025P4')
      expect(submission.blanketterSru).toContain('#BLANKETT INK2R-2025P4')
      expect(submission.blanketterSru).toContain('#BLANKETT INK2S-2025P4')
      expect(submission.blanketterSru).toContain('#FIL_SLUT')
    })

    it('validates the generated BLANKETTER.SRU', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)
      const validation = validateBlanketterSru(submission.blanketterSru)
      expect(validation.isValid).toBe(true)
      expect(validation.errors).toEqual([])
    })

    it('uses correct period suffix for calendar year', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)
      // Dec = P4
      expect(submission.blanketterSru).toContain('INK2-2025P4')
    })

    it('uses P1 suffix for fiscal year ending in Jan-Apr', () => {
      const declaration = makeDeclaration({
        fiscalYear: {
          id: 'p1',
          name: 'FY',
          start: '2024-05-01',
          end: '2025-04-30',
          isClosed: true,
        },
      })
      const submission = generateSRUSubmission(declaration)
      expect(submission.blanketterSru).toContain('INK2-2025P1')
    })

    it('uses P2 suffix for fiscal year ending in May-Aug', () => {
      const declaration = makeDeclaration({
        fiscalYear: {
          id: 'p2',
          name: 'FY',
          start: '2024-09-01',
          end: '2025-06-30',
          isClosed: true,
        },
      })
      const submission = generateSRUSubmission(declaration)
      expect(submission.blanketterSru).toContain('INK2-2025P2')
    })

    it('excludes zero-value #UPPGIFT lines', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)

      // 7201 is 0, should not appear
      const ink2rBlock = extractBlock(submission.blanketterSru, 'INK2R')
      expect(ink2rBlock).not.toContain('#UPPGIFT 7201')
      // 7215 is 50000, should appear
      expect(ink2rBlock).toContain('#UPPGIFT 7215 50000')
    })

    it('includes fiscal year fields 7011 and 7012 in each block', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)

      // Each block should have 7011 and 7012
      const blocks = [
        extractBlock(submission.blanketterSru, 'INK2-'),
        extractBlock(submission.blanketterSru, 'INK2R'),
        extractBlock(submission.blanketterSru, 'INK2S'),
      ]
      for (const block of blocks) {
        expect(block).toContain('#UPPGIFT 7011 20250101')
        expect(block).toContain('#UPPGIFT 7012 20251231')
      }
    })

    it('each blankett block has #IDENTITET and #NAMN', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)

      const blocks = submission.blanketterSru.split('#BLANKETT ').slice(1)
      expect(blocks).toHaveLength(3)

      for (const block of blocks) {
        expect(block).toContain('#IDENTITET 165566778899')
        expect(block).toContain('#NAMN Test AB')
        expect(block).toContain('#BLANKETTSLUT')
      }
    })

    it('reports cost fields as positive values per Skatteverket convention', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)

      const ink2rBlock = extractBlock(submission.blanketterSru, 'INK2R')
      expect(ink2rBlock).toContain('#UPPGIFT 7513 100000')
      expect(ink2rBlock).toContain('#UPPGIFT 7522 3000')
    })

    it('handles bokslutsdispositioner fields with correct sign', () => {
      const declaration = makeDeclaration({
        ink2r: {
          ...makeDeclaration().ink2r,
          '7524': 50000,  // Lämnade koncernbidrag (debit-normal cost, positive)
          '7525': 30000,  // Avsättning periodiseringsfond (debit-normal cost, positive)
          '7419': 20000,  // Mottagna koncernbidrag (credit-normal income, positive)
        },
      })
      const submission = generateSRUSubmission(declaration)
      const ink2rBlock = extractBlock(submission.blanketterSru, 'INK2R')

      // All bokslutsdispositioner fields are positive in the SRU output
      expect(ink2rBlock).toContain('#UPPGIFT 7524 50000')
      expect(ink2rBlock).toContain('#UPPGIFT 7525 30000')
      expect(ink2rBlock).toContain('#UPPGIFT 7419 20000')
    })

    it('includes INK2S with överskott/underskott', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)

      const ink2sBlock = extractBlock(submission.blanketterSru, 'INK2S')
      expect(ink2sBlock).toContain('#UPPGIFT 7650 302000')
      expect(ink2sBlock).toContain('#UPPGIFT 8020 302000')
      // 7750 and 8021 are 0, should not appear
      expect(ink2sBlock).not.toContain('#UPPGIFT 7750')
      expect(ink2sBlock).not.toContain('#UPPGIFT 8021')
    })

    it('includes saved non-deductible and non-taxable adjustments in INK2S', () => {
      const base = makeDeclaration()
      const declaration = makeDeclaration({
        ink2s: {
          ...base.ink2s,
          '7653': 5_244,
          '7754': 1_000,
        },
      })
      const submission = generateSRUSubmission(declaration)
      const ink2sBlock = extractBlock(submission.blanketterSru, 'INK2S')

      expect(ink2sBlock).toContain('#UPPGIFT 7653 5244')
      expect(ink2sBlock).toContain('#UPPGIFT 7754 1000')
    })

    it('INK2 block includes överskott', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)

      const ink2Block = extractBlock(submission.blanketterSru, 'INK2-')
      expect(ink2Block).toContain('#UPPGIFT 7104 302000')
      // 7114 (underskott) is 0, should not appear
      expect(ink2Block).not.toContain('#UPPGIFT 7114')
    })

    it('uses CRLF line endings', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)
      expect(submission.infoSru).toContain('\r\n')
      expect(submission.blanketterSru).toContain('\r\n')
    })

    it('sanitizes # from company name', () => {
      const declaration = makeDeclaration({
        companyInfo: {
          companyName: 'Test #1 AB',
          orgNumber: '556677-8899',
          addressLine1: null,
          postalCode: '11122',
          city: 'Stockholm',
          email: null,
        },
      })
      const submission = generateSRUSubmission(declaration)
      expect(submission.infoSru).toContain('#NAMN Test 1 AB')
    })
  })

  describe('validateBlanketterSru', () => {
    it('validates a correct BLANKETTER.SRU', () => {
      const declaration = makeDeclaration()
      const submission = generateSRUSubmission(declaration)
      const result = validateBlanketterSru(submission.blanketterSru)
      expect(result.isValid).toBe(true)
    })

    it('detects missing INK2R block', () => {
      const result = validateBlanketterSru(
        '#BLANKETT INK2-2025P4\r\n#IDENTITET 165566778899 20250101 100000\r\n#NAMN Test\r\n#BLANKETTSLUT\r\n' +
        '#BLANKETT INK2S-2025P4\r\n#IDENTITET 165566778899 20250101 100002\r\n#NAMN Test\r\n#BLANKETTSLUT\r\n' +
        '#FIL_SLUT\r\n'
      )
      expect(result.isValid).toBe(false)
      expect(result.errors).toContain('Missing INK2R blankett block')
    })

    it('detects missing #FIL_SLUT', () => {
      const result = validateBlanketterSru(
        '#BLANKETT INK2-2025P4\r\n#IDENTITET x\r\n#NAMN T\r\n#BLANKETTSLUT\r\n' +
        '#BLANKETT INK2R-2025P4\r\n#IDENTITET x\r\n#NAMN T\r\n#BLANKETTSLUT\r\n' +
        '#BLANKETT INK2S-2025P4\r\n#IDENTITET x\r\n#NAMN T\r\n#BLANKETTSLUT\r\n'
      )
      expect(result.isValid).toBe(false)
      expect(result.errors).toContain('Missing #FIL_SLUT terminator')
    })
  })

  describe('getZipFilename', () => {
    it('returns correct filename format', () => {
      const declaration = makeDeclaration()
      expect(getZipFilename(declaration)).toBe('INK2_SRU_5566778899_2025.zip')
    })

    it('handles missing org number', () => {
      const declaration = makeDeclaration({
        companyInfo: {
          companyName: 'Test AB',
          orgNumber: null,
          addressLine1: null,
          postalCode: null,
          city: null,
          email: null,
        },
      })
      expect(getZipFilename(declaration)).toBe('INK2_SRU_unknown_2025.zip')
    })
  })
})

/** Extract a specific blankett block from BLANKETTER.SRU content */
function extractBlock(content: string, blockPrefix: string): string {
  const regex = new RegExp(`#BLANKETT ${blockPrefix}[^\\r\\n]*[\\s\\S]*?#BLANKETTSLUT`)
  const match = content.match(regex)
  return match ? match[0] : ''
}
