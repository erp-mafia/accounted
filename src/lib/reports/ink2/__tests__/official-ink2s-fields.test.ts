import { describe, expect, it } from 'vitest'
import official from '../official-ink2s-fields.json'
import { generateSRUSubmission } from '../sru-generator'
import type { INK2Declaration, INK2SRutor } from '../types'

/**
 * Every INK2S field code the engine emits must exist in Skatteverket's
 * official field table (INK2S_SKV2002-33-01-24-04, 2025P4 package, valid
 * through 2026P3), transcribed in official-ink2s-fields.json, and must sit
 * on the row the code is documented to carry. #2686: the taxable result was
 * filed on 8020/8021 (4.17/4.18, värdeminskningsavdrag byggnader and
 * markanläggningar) instead of 7670/7770 (4.15/4.16), so every generated
 * BLANKETTER.SRU left the result rows empty and put the amount in the
 * building-depreciation fields.
 */

const fields = official.fields as Record<string, { row: string | null; label: string; sign: string | null; rule?: string }>

/** Row each emitted code is meant to carry, as documented in types.ts. */
const EMITTED_INK2S_ROWS: Record<keyof INK2SRutor, string | null> = {
  '7011': null,
  '7012': null,
  '7650': '4.1',
  '7750': '4.2',
  '7651': '4.3a',
  '7653': '4.3c',
  '7754': '4.5c',
  '7763': '4.14a',
  '7670': '4.15',
  '7770': '4.16',
}

function sampleDeclaration(overrides: Partial<INK2SRutor>): INK2Declaration {
  return {
    fiscalYear: {
      id: 'period-1',
      name: 'Räkenskapsår 2025',
      start: '2025-01-01',
      end: '2025-12-31',
      isClosed: true,
    },
    ink2: { '7011': '20250101', '7012': '20251231', '7104': 0, '7114': 0 },
    ink2r: {} as INK2Declaration['ink2r'],
    breakdown: {} as INK2Declaration['breakdown'],
    totals: { totalAssets: 0, totalEquityLiabilities: 0, operatingResult: 0, aretsResultat: 0 },
    companyInfo: {
      companyName: 'Testbolaget AB',
      orgNumber: '556000-0100',
      addressLine1: 'Testgatan 1',
      postalCode: '11122',
      city: 'Stockholm',
      email: 'test@example.com',
    },
    ink2s: {
      '7011': '20250101',
      '7012': '20251231',
      '7650': 0,
      '7750': 0,
      '7651': 0,
      '7653': 0,
      '7754': 0,
      '7763': 0,
      '7670': 0,
      '7770': 0,
      ...overrides,
    },
    warnings: [],
  }
}

describe('INK2S field codes against the official Skatteverket table', () => {
  it('emits only codes that exist on INK2S, each on its documented row', () => {
    for (const [code, row] of Object.entries(EMITTED_INK2S_ROWS)) {
      expect(fields[code], `SRU code ${code} is not an INK2S field`).toBeDefined()
      expect(fields[code].row, `SRU code ${code} sits on row ${fields[code].row}`).toBe(row)
    }
  })

  it('files the taxable result on 7670 (4.15) and 7770 (4.16), never on the depreciation fields', () => {
    expect(fields['7670'].label).toMatch(/^Överskott \(flyttas till p\. 1\.1/)
    expect(fields['7770'].label).toMatch(/^Underskott \(flyttas till p\. 1\.2/)
    expect(fields['8020'].row).toBe('4.17')
    expect(fields['8021'].row).toBe('4.18')

    const surplus = generateSRUSubmission(sampleDeclaration({ '7650': 500_000, '7670': 406_000 })).blanketterSru
    expect(surplus).toContain('#UPPGIFT 7670 406000')
    expect(surplus).not.toMatch(/#UPPGIFT 802[01] /)

    const deficit = generateSRUSubmission(sampleDeclaration({ '7750': 20_000, '7770': 94_000 })).blanketterSru
    expect(deficit).toContain('#UPPGIFT 7770 94000')
    expect(deficit).not.toContain('#UPPGIFT 7670')
    expect(deficit).not.toMatch(/#UPPGIFT 802[01] /)
  })

  it('never files both 7670 and 7770 in one block (Skatteverket rule on the row)', () => {
    expect(fields['7670'].rule).toMatch(/7770/)
    expect(fields['7770'].rule).toMatch(/7670/)
    const sru = generateSRUSubmission(sampleDeclaration({ '7670': 1_000 })).blanketterSru
    expect(sru).toContain('#UPPGIFT 7670 1000')
    expect(sru).not.toContain('#UPPGIFT 7770')
  })
})
