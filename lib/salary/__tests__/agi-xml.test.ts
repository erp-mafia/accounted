import { describe, it, expect, vi } from 'vitest'
import {
  generateAGIXml,
  buildIndividuppgifterSnapshot,
  AGIIncompleteDataError,
} from '../agi/xml-generator'
import type { AGICompanyData, AGIEmployeeData, AGITotals } from '../agi/xml-generator'

// Mock personnummer decryption
vi.mock('../personnummer', () => ({
  decryptPersonnummer: (encrypted: string) => {
    if (encrypted === 'emp1_encrypted') return '199001011234'
    if (encrypted === 'emp2_encrypted') return '198506159876'
    return '000000000000'
  },
}))

const company: AGICompanyData = {
  orgNumber: '556123-4567',
  companyName: 'Test AB',
  periodYear: 2026,
  periodMonth: 4,
  contactName: 'Anna Admin',
  contactPhone: '0701234567',
  contactEmail: 'anna@test.se',
}

const employees: AGIEmployeeData[] = [
  {
    personnummer: 'emp1_encrypted',
    specificationNumber: 1,
    grossSalary: 40000,
    taxWithheld: 12000,
    avgifterBasis: 40000,
  },
  {
    personnummer: 'emp2_encrypted',
    specificationNumber: 2,
    grossSalary: 35000,
    taxWithheld: 10500,
    avgifterBasis: 35000,
    benefitCar: 5000,
  },
]

const totals: AGITotals = {
  totalTax: 22500,
  totalAvgifterBasis: 80000,
  totalAvgifterAmount: 24075.5,
  avgifterByCategory: {
    standard: { basis: 75000, amount: 23565 },
    reduced65plus: { basis: 5000, amount: 510.5 },
  },
}

describe('generateAGIXml — root structure', () => {
  it('starts with XML declaration', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
  })

  it('uses the Skatteverket AGI namespace (schema 1.1)', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('xmlns="http://xmls.skatteverket.se/se/skatteverket/da/instans/schema/1.1"')
    // Declares the komponent namespace for shared building blocks (Avsandare etc.)
    expect(xml).toContain('xmlns:gem="http://xmls.skatteverket.se/se/skatteverket/da/komponent/schema/1.1"')
    // Reject the old bogus namespace
    expect(xml).not.toContain('infoForBeskworksgiv')
    expect(xml).not.toContain('/ai/instans/')
  })

  it('sets omrade="Arbetsgivardeklaration" on the root element', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<Skatteverket omrade="Arbetsgivardeklaration"')
  })

  it('closes the Skatteverket element', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('</Skatteverket>')
  })
})

describe('generateAGIXml — Avsandare', () => {
  it('includes program name "gnubok"', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:Programnamn>gnubok</gem:Programnamn>')
  })

  it('emits Organisationsnummer in IDENTITET format (16 + 10-digit AB orgnr)', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:Organisationsnummer>165561234567</gem:Organisationsnummer>')
    expect(xml).not.toContain('556123-4567')
  })

  it('includes technical contact (name, phone, email)', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:Namn>Anna Admin</gem:Namn>')
    expect(xml).toContain('<gem:Telefon>0701234567</gem:Telefon>')
    expect(xml).toContain('<gem:Epostadress>anna@test.se</gem:Epostadress>')
  })

  it('emits Avsandare in the komponent namespace (gem: prefix)', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:Avsandare>')
    expect(xml).toContain('</gem:Avsandare>')
  })
})

describe('generateAGIXml — Blankettgemensamt', () => {
  it('includes AgRegistreradId for the employer in IDENTITET format', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:AgRegistreradId>165561234567</gem:AgRegistreradId>')
  })

  it('emits Blankettgemensamt in the komponent namespace', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:Blankettgemensamt>')
    expect(xml).toContain('</gem:Blankettgemensamt>')
  })
})

describe('generateAGIXml — Huvuduppgift (HU)', () => {
  it('includes AgRegistreradId with FK201 inside HU (IDENTITET format)', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:AgRegistreradId faltkod="201">165561234567</gem:AgRegistreradId>')
  })

  it('includes RedovisningsPeriod with FK006 inside HU', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:RedovisningsPeriod faltkod="006">202604</gem:RedovisningsPeriod>')
  })

  it('emits total tax as SummaSkatteavdr FK497 (not AvdragenSkatt FK001)', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:SummaSkatteavdr faltkod="497">22500</gem:SummaSkatteavdr>')
    // Legacy incorrect HU element must not appear
    expect(xml).not.toMatch(/<gem:HU>[\s\S]*<AvdragenSkatt[\s\S]*<\/gem:HU>/)
  })

  it('emits total employer contributions as SummaArbAvgSlf FK487', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:SummaArbAvgSlf faltkod="487">24076</gem:SummaArbAvgSlf>')
  })

  it('does NOT emit FK060/061/062 — those field codes do not exist in HU', () => {
    const xml = generateAGIXml(company, employees, totals)
    // Look for those faltkoder inside the HU section
    const huMatch = xml.match(/<gem:HU>[\s\S]*?<\/gem:HU>/)
    expect(huMatch).not.toBeNull()
    const hu = huMatch![0]
    expect(hu).not.toContain('faltkod="060"')
    expect(hu).not.toContain('faltkod="061"')
    expect(hu).not.toContain('faltkod="062"')
  })

  it('emits TotalSjuklonekostnad FK499 when sjuklön cost is reported', () => {
    const withSjuklon = { ...totals, totalSjuklonekostnad: 4200 }
    const xml = generateAGIXml(company, employees, withSjuklon)
    expect(xml).toContain('<gem:TotalSjuklonekostnad faltkod="499">4200</gem:TotalSjuklonekostnad>')
  })

  it('omits TotalSjuklonekostnad when zero or undefined', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).not.toContain('TotalSjuklonekostnad')
    const zero = { ...totals, totalSjuklonekostnad: 0 }
    expect(generateAGIXml(company, employees, zero)).not.toContain('TotalSjuklonekostnad')
  })
})

describe('generateAGIXml — Individuppgift (IU)', () => {
  it('uses BetalningsmottagarId FK215 (not Personnummer) for the payment recipient', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:BetalningsmottagarId faltkod="215">199001011234</gem:BetalningsmottagarId>')
    expect(xml).toContain('<gem:BetalningsmottagarId faltkod="215">198506159876</gem:BetalningsmottagarId>')
    expect(xml).not.toContain('<Personnummer faltkod="215">')
  })

  it('wraps BetalningsmottagarId in BetalningsmottagareIUGROUP → BetalningsmottagareIDChoice', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:BetalningsmottagareIUGROUP>')
    expect(xml).toContain('<gem:BetalningsmottagareIDChoice>')
    expect(xml).toContain('</gem:BetalningsmottagareIDChoice>')
    expect(xml).toContain('</gem:BetalningsmottagareIUGROUP>')
    // Ensure correct nesting order (IUGROUP contains IDChoice which contains the id)
    expect(xml).toMatch(/<gem:BetalningsmottagareIUGROUP>\s*<gem:BetalningsmottagareIDChoice>\s*<gem:BetalningsmottagarId/)
  })

  it('wraps AgRegistreradId in ArbetsgivareIUGROUP inside IU', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:ArbetsgivareIUGROUP>')
    expect(xml).toContain('</gem:ArbetsgivareIUGROUP>')
  })

  it('preserves Specifikationsnummer FK570 per employee', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:Specifikationsnummer faltkod="570">1</gem:Specifikationsnummer>')
    expect(xml).toContain('<gem:Specifikationsnummer faltkod="570">2</gem:Specifikationsnummer>')
  })

  it('uses KontantErsattningUlagAG FK011 (not KontantBruttoloen) for gross salary', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:KontantErsattningUlagAG faltkod="011">40000</gem:KontantErsattningUlagAG>')
    expect(xml).toContain('<gem:KontantErsattningUlagAG faltkod="011">35000</gem:KontantErsattningUlagAG>')
    expect(xml).not.toContain('KontantBruttoloen')
  })

  it('uses AvdrPrelSkatt FK001 (not AvdragenSkatt) for withheld tax in IU', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:AvdrPrelSkatt faltkod="001">12000</gem:AvdrPrelSkatt>')
    expect(xml).toContain('<gem:AvdrPrelSkatt faltkod="001">10500</gem:AvdrPrelSkatt>')
  })

  it('includes AgRegistreradId and RedovisningsPeriod in every IU', () => {
    const xml = generateAGIXml(company, employees, totals)
    // 1 HU + 2 IU = 3 occurrences each
    const agRegMatches = xml.match(/AgRegistreradId faltkod="201"/g)
    const periodMatches = xml.match(/RedovisningsPeriod faltkod="006"/g)
    expect(agRegMatches?.length).toBe(3)
    expect(periodMatches?.length).toBe(3)
  })

  it('maps benefit_car to SkatteplBilformanUlagAG FK013 (not FormanBil FK012)', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).toContain('<gem:SkatteplBilformanUlagAG faltkod="013">5000</gem:SkatteplBilformanUlagAG>')
    expect(xml).not.toContain('FormanBil')
  })

  it('omits empty/zero fields', () => {
    const xml = generateAGIXml(company, employees, totals)
    const lines = xml.split('\n')
    for (const line of lines) {
      if (line.includes('faltkod')) {
        expect(line).not.toMatch(/>0<\//)
      }
    }
  })

  it('escapes XML special characters in contact info', () => {
    const specialCompany = { ...company, contactName: 'A&B <Admin>' }
    const xml = generateAGIXml(specialCompany, employees, totals)
    expect(xml).not.toContain('A&B <Admin>')
    expect(xml).toContain('A&amp;B &lt;Admin&gt;')
  })
})

describe('generateAGIXml — fail-fast on missing data', () => {
  it('throws AGIIncompleteDataError when org number is missing', () => {
    const bad = { ...company, orgNumber: '' }
    expect(() => generateAGIXml(bad, employees, totals)).toThrow(AGIIncompleteDataError)
    expect(() => generateAGIXml(bad, employees, totals)).toThrow(/organisationsnummer/)
  })

  it('throws when org number has too few digits', () => {
    const bad = { ...company, orgNumber: '12345' }
    expect(() => generateAGIXml(bad, employees, totals)).toThrow(AGIIncompleteDataError)
  })

  it('throws when contact phone is missing', () => {
    const bad = { ...company, contactPhone: '' }
    expect(() => generateAGIXml(bad, employees, totals)).toThrow(/telefon/)
  })

  it('throws when contact email is missing', () => {
    const bad = { ...company, contactEmail: '' }
    expect(() => generateAGIXml(bad, employees, totals)).toThrow(/e-post/)
  })

  it('lists all missing fields on the error', () => {
    const bad = { ...company, orgNumber: '', contactPhone: '', contactEmail: '' }
    try {
      generateAGIXml(bad, employees, totals)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AGIIncompleteDataError)
      expect((err as AGIIncompleteDataError).missingFields).toEqual(
        expect.arrayContaining(['organisationsnummer', 'telefon', 'e-post'])
      )
    }
  })
})

describe('buildIndividuppgifterSnapshot', () => {
  it('builds snapshot with decrypted personnummer', () => {
    const snapshot = buildIndividuppgifterSnapshot(employees)
    expect(snapshot).toHaveLength(2)
    expect(snapshot[0].personnummer).toBe('199001011234')
    expect(snapshot[1].personnummer).toBe('198506159876')
  })

  it('preserves specificationNumber for correction reference', () => {
    const snapshot = buildIndividuppgifterSnapshot(employees)
    expect(snapshot[0].specificationNumber).toBe(1)
    expect(snapshot[1].specificationNumber).toBe(2)
  })

  it('includes the core IU amounts', () => {
    const snapshot = buildIndividuppgifterSnapshot(employees)
    expect(snapshot[0]).toHaveProperty('grossSalary', 40000)
    expect(snapshot[0]).toHaveProperty('taxWithheld', 12000)
    expect(snapshot[0]).toHaveProperty('avgifterBasis', 40000)
  })
})

// ─── Frånvarouppgift (FK820-827) ────────────────────────────────────

describe('generateAGIXml — Frånvarouppgift', () => {
  const employeesWithAbsence: AGIEmployeeData[] = [
    {
      personnummer: 'emp1_encrypted',
      specificationNumber: 1,
      grossSalary: 40000,
      taxWithheld: 12000,
      avgifterBasis: 40000,
      absenceEvents: [
        { date: '2026-04-15', type: 'vab', hours: 8, specifikationsnummer: 1 },
        { date: '2026-04-16', type: 'vab', hours: 4, specifikationsnummer: 2 },
      ],
    },
    {
      personnummer: 'emp2_encrypted',
      specificationNumber: 2,
      grossSalary: 35000,
      taxWithheld: 10500,
      avgifterBasis: 35000,
      absenceEvents: [
        { date: '2026-04-20', type: 'parental', hours: 8, specifikationsnummer: 1 },
      ],
    },
  ]

  it('emits a <gem:Franvarouppgift> per absence event', () => {
    const xml = generateAGIXml(company, employeesWithAbsence, totals)
    const matches = xml.match(/<gem:Franvarouppgift>/g) ?? []
    expect(matches).toHaveLength(3)
  })

  it('emits TILLFALLIG_FORALDRAPENNING with FranvaroTimmarTFP for VAB', () => {
    const xml = generateAGIXml(company, employeesWithAbsence, totals)
    expect(xml).toContain('<gem:FranvaroTyp faltkod="823">TILLFALLIG_FORALDRAPENNING</gem:FranvaroTyp>')
    expect(xml).toContain('<gem:FranvaroTimmarTFP faltkod="825">8</gem:FranvaroTimmarTFP>')
    expect(xml).toContain('<gem:FranvaroTimmarTFP faltkod="825">4</gem:FranvaroTimmarTFP>')
  })

  it('emits FORALDRAPENNING with FranvaroTimmarFP for parental leave', () => {
    const xml = generateAGIXml(company, employeesWithAbsence, totals)
    expect(xml).toContain('<gem:FranvaroTyp faltkod="823">FORALDRAPENNING</gem:FranvaroTyp>')
    expect(xml).toContain('<gem:FranvaroTimmarFP faltkod="827">8</gem:FranvaroTimmarFP>')
  })

  it('does NOT emit TFP hour-fields for parental events', () => {
    const xml = generateAGIXml(
      company,
      [{
        ...employeesWithAbsence[1],
        absenceEvents: [{ date: '2026-04-20', type: 'parental', hours: 8, specifikationsnummer: 1 }],
      }],
      totals,
    )
    expect(xml).not.toMatch(/FranvaroTimmarTFP|FranvaroProcentTFP/)
  })

  it('emits the persisted specifikationsnummer per event (stable across corrections)', () => {
    const xml = generateAGIXml(company, employeesWithAbsence, totals)
    // emp1 has two events with specnummer 1 and 2 (assigned by DB trigger);
    // emp2 has one event with specnummer 1. The values come from the
    // event object — they are NOT recomputed from array index.
    expect(xml).toContain('<gem:FranvaroSpecifikationsnummer faltkod="822">1</gem:FranvaroSpecifikationsnummer>')
    expect(xml).toContain('<gem:FranvaroSpecifikationsnummer faltkod="822">2</gem:FranvaroSpecifikationsnummer>')
  })

  it('preserves the persisted specnummer even when an earlier event is removed', () => {
    // Simulates the correction scenario the persistence is designed for:
    // the first vab day was deleted, so the remaining day keeps its
    // original specnummer (2). Without persistence the index would shift
    // to 1 and Skatteverket would treat it as a replacement of the
    // already-filed day-1 event.
    const xml = generateAGIXml(
      company,
      [{
        ...employeesWithAbsence[0],
        absenceEvents: [
          { date: '2026-04-16', type: 'vab', hours: 4, specifikationsnummer: 2 },
        ],
      }],
      totals,
    )
    expect(xml).toContain('<gem:FranvaroSpecifikationsnummer faltkod="822">2</gem:FranvaroSpecifikationsnummer>')
    expect(xml).not.toContain('<gem:FranvaroSpecifikationsnummer faltkod="822">1</gem:FranvaroSpecifikationsnummer>')
  })

  it('formats fractional hours with up to 2 decimals', () => {
    const xml = generateAGIXml(
      company,
      [{
        ...employeesWithAbsence[0],
        absenceEvents: [{ date: '2026-04-15', type: 'vab', hours: 4.5, specifikationsnummer: 1 }],
      }],
      totals,
    )
    expect(xml).toContain('<gem:FranvaroTimmarTFP faltkod="825">4.5</gem:FranvaroTimmarTFP>')
  })

  it('clamps hours into the spec range (0.01–24.00)', () => {
    const xml = generateAGIXml(
      company,
      [{
        ...employeesWithAbsence[0],
        absenceEvents: [{ date: '2026-04-15', type: 'vab', hours: 50, specifikationsnummer: 1 }],
      }],
      totals,
    )
    expect(xml).toContain('<gem:FranvaroTimmarTFP faltkod="825">24</gem:FranvaroTimmarTFP>')
  })

  it('skips Frånvarouppgift entirely for periods before 202501', () => {
    const xml = generateAGIXml(
      { ...company, periodYear: 2024, periodMonth: 12 },
      employeesWithAbsence,
      totals,
    )
    expect(xml).not.toContain('Franvarouppgift')
  })

  it('emits Frånvarouppgift for the boundary period 202501', () => {
    const xml = generateAGIXml(
      { ...company, periodYear: 2025, periodMonth: 1 },
      [{
        ...employeesWithAbsence[0],
        absenceEvents: [{ date: '2025-01-15', type: 'vab', hours: 8, specifikationsnummer: 1 }],
      }],
      totals,
    )
    expect(xml).toContain('<gem:Franvarouppgift>')
    expect(xml).toContain('<gem:FranvaroDatum faltkod="821">2025-01-15</gem:FranvaroDatum>')
  })

  it('places Frånvarouppgift after IU Blanketts and before </Skatteverket>', () => {
    const xml = generateAGIXml(company, employeesWithAbsence, totals)
    const lastBlankettClose = xml.lastIndexOf('</gem:Blankett>')
    const firstFranvaro = xml.indexOf('<gem:Franvarouppgift>')
    const closeRoot = xml.indexOf('</Skatteverket>')
    expect(firstFranvaro).toBeGreaterThan(lastBlankettClose)
    expect(closeRoot).toBeGreaterThan(firstFranvaro)
  })

  it('emits FK820/824/826 absence-removal and percent fields not at all (Accounted always sends timmar)', () => {
    const xml = generateAGIXml(company, employeesWithAbsence, totals)
    expect(xml).not.toContain('faltkod="820"')
    expect(xml).not.toContain('faltkod="824"')
    expect(xml).not.toContain('faltkod="826"')
  })

  it('preserves date order across employees with mixed types', () => {
    const xml = generateAGIXml(company, employeesWithAbsence, totals)
    const idx15 = xml.indexOf('2026-04-15')
    const idx16 = xml.indexOf('2026-04-16')
    const idx20 = xml.indexOf('2026-04-20')
    expect(idx15).toBeLessThan(idx16)
    expect(idx16).toBeLessThan(idx20)
  })

  it('emits required fields per Frånvarouppgift (AgRegistreradId, RedovisningsPeriod, FranvaroDatum, BetalningsmottagarId, Specifikationsnummer, FranvaroChoice)', () => {
    const xml = generateAGIXml(
      company,
      [{
        ...employeesWithAbsence[0],
        absenceEvents: [{ date: '2026-04-15', type: 'vab', hours: 8, specifikationsnummer: 1 }],
      }],
      totals,
    )
    // Single Frånvarouppgift block
    const block = xml.slice(xml.indexOf('<gem:Franvarouppgift>'), xml.indexOf('</gem:Franvarouppgift>'))
    expect(block).toContain('faltkod="201"') // AgRegistreradId
    expect(block).toContain('faltkod="006"') // RedovisningsPeriod
    expect(block).toContain('faltkod="821"') // FranvaroDatum
    expect(block).toContain('faltkod="215"') // BetalningsmottagarId
    expect(block).toContain('faltkod="822"') // FranvaroSpecifikationsnummer
    expect(block).toContain('<gem:FranvaroChoice>')
    expect(block).toContain('faltkod="823"') // FranvaroTyp inside choice
  })

  it('omits the section entirely when no employee has absenceEvents', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).not.toContain('Franvarouppgift')
  })
})

describe('generateAGIXml — nolldeklaration (HU-only, no IU)', () => {
  const zeroTotals: AGITotals = {
    totalTax: 0,
    totalAvgifterBasis: 0,
    totalAvgifterAmount: 0,
    totalSjuklonekostnad: 0,
    avgifterByCategory: {},
  }

  it('produces a valid declaration with an HU but no individuppgifter when the roster is empty', () => {
    const xml = generateAGIXml(company, [], zeroTotals)
    // Root + HU present
    expect(xml).toContain('<Skatteverket omrade="Arbetsgivardeklaration"')
    expect(xml).toContain('</Skatteverket>')
    expect(xml).toContain('<gem:RedovisningsPeriod faltkod="006">202604</gem:RedovisningsPeriod>')
    expect(xml).toContain('<gem:AgRegistreradId faltkod="201">165561234567</gem:AgRegistreradId>')
    // No individuppgifter and no absence section
    expect(xml).not.toContain('<gem:IU>')
    expect(xml).not.toContain('Franvarouppgift')
  })

  it('omits every zero HU total field (FK497/FK487/FK499)', () => {
    const xml = generateAGIXml(company, [], zeroTotals)
    expect(xml).not.toContain('faltkod="497"') // SummaSkatteavdr
    expect(xml).not.toContain('faltkod="487"') // SummaArbAvgSlf
    expect(xml).not.toContain('faltkod="499"') // TotalSjuklonekostnad
  })

  it('still validates required company data for a nolldeklaration', () => {
    expect(() =>
      generateAGIXml({ ...company, orgNumber: '' }, [], zeroTotals),
    ).toThrow(AGIIncompleteDataError)
  })
})
