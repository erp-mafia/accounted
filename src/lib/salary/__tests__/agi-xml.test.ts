import { describe, it, expect, vi } from 'vitest'
import {
  generateAGIXml,
  buildIndividuppgifterSnapshot,
  AGIIncompleteDataError,
  findMissingCompanyData,
} from '../agi/xml-generator'
import type { AGICompanyData, AGIEmployeeData, AGITotals } from '../agi/xml-generator'
import { maskPersonnummerInText } from '../personnummer-format'

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

describe('generateAGIXml: root structure', () => {
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

describe('generateAGIXml: Avsandare', () => {
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

describe('generateAGIXml: Blankettgemensamt', () => {
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

describe('generateAGIXml: Huvuduppgift (HU)', () => {
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

  it('emits total employer contributions as SummaArbAvgSlf FK487 with öre truncated', () => {
    const xml = generateAGIXml(company, employees, totals)
    // 24 075,50 declares as 24 075: öretal bortfaller (SFF 2011:1261
    // 22 kap. 1 §), truncation, never rounding. Math.round would declare
    // 1 kr more than Skatteverket draws from the skattekonto.
    expect(xml).toContain('<gem:SummaArbAvgSlf faltkod="487">24075</gem:SummaArbAvgSlf>')
  })

  it('truncates öre on every HU amount, even at ,99', () => {
    const oreTotals: AGITotals = {
      ...totals,
      totalTax: 12268,
      totalAvgifterAmount: 16073.84,
    }
    const xml = generateAGIXml(company, employees, oreTotals)
    expect(xml).toContain('<gem:SummaSkatteavdr faltkod="497">12268</gem:SummaSkatteavdr>')
    expect(xml).toContain('<gem:SummaArbAvgSlf faltkod="487">16073</gem:SummaArbAvgSlf>')
  })

  it('does not let IEEE drift under an exact krona lose it in truncation', () => {
    // 51 158 × 0,3142 = 16 073.843600000001 in floats; a raw Math.trunc of
    // a value like 16 074 stored as 16 073.999999999 would drop a whole
    // krona. truncateToWholeKronor rounds to öre first.
    const driftTotals: AGITotals = {
      ...totals,
      totalAvgifterAmount: 16073.999999999998,
    }
    const xml = generateAGIXml(company, employees, driftTotals)
    expect(xml).toContain('<gem:SummaArbAvgSlf faltkod="487">16074</gem:SummaArbAvgSlf>')
  })

  it('does NOT emit FK060/061/062: those field codes do not exist in HU', () => {
    const xml = generateAGIXml(company, employees, totals)
    // Look for those faltkoder inside the HU section
    const huMatch = xml.match(/<gem:HU>[\s\S]*?<\/gem:HU>/)
    expect(huMatch).not.toBeNull()
    const hu = huMatch![0]
    expect(hu).not.toContain('faltkod="060"')
    expect(hu).not.toContain('faltkod="061"')
    expect(hu).not.toContain('faltkod="062"')
  })

  it('emits regionalt stöd as FK471 underlag and FK476 avdrag in HU (PH 208)', () => {
    const xml = generateAGIXml(company, employees, {
      ...totals,
      // FK487 is the avgift after the avdrag (IK587, kontroll B_006).
      totalAvgifterAmount: 24075 - 7100,
      regionalSupport: { underlag: 75000, deduction: 7100 },
    })
    const hu = xml.match(/<gem:HU>[\s\S]*?<\/gem:HU>/)![0]
    expect(hu).toContain('<gem:UlagRegionaltStod faltkod="471">75000</gem:UlagRegionaltStod>')
    expect(hu).toContain('<gem:AvdragRegionaltStod faltkod="476">7100</gem:AvdragRegionaltStod>')
    expect(hu).toContain('<gem:SummaArbAvgSlf faltkod="487">16975</gem:SummaArbAvgSlf>')
  })

  it('emits neither FK471 nor FK476 without regionalt stöd (kontroll S_106/S_108)', () => {
    for (const regionalSupport of [undefined, null, { underlag: 9, deduction: 0 }]) {
      const xml = generateAGIXml(company, employees, { ...totals, regionalSupport })
      expect(xml).not.toContain('faltkod="471"')
      expect(xml).not.toContain('faltkod="476"')
    }
  })

  it('never emits FK499 TotalSjuklonekostnad: retired with högkostnadsskyddet, invalid after 202406', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).not.toContain('faltkod="499"')
    expect(xml).not.toContain('TotalSjuklonekostnad')
  })
})

describe('generateAGIXml: Individuppgift (IU)', () => {
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
    // Both fixtures withhold tax. FK001 is the one field declared even at 0
    // (kontroll S_183): see the skattefält block below.
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

describe('generateAGIXml: ej underlag för socialavgifter IU (FK131)', () => {
  // The underlag picks the cash field: the same payment must never appear as
  // both FK011 (underlag AG) and FK131 (ej underlag SA).
  const ejUlagSAEmployee: AGIEmployeeData = {
    personnummer: 'emp2_encrypted',
    specificationNumber: 3,
    grossSalary: 15000,
    taxWithheld: 0,
    avgifterBasis: 0,
    underlag: 'ej_socialavgifter',
  }

  it('emits KontantErsattningEjUlagSA FK131 with the payment amount', () => {
    const xml = generateAGIXml(company, [ejUlagSAEmployee], totals)
    expect(xml).toContain(
      '<gem:KontantErsattningEjUlagSA faltkod="131">15000</gem:KontantErsattningEjUlagSA>'
    )
  })

  it('does not emit FK011 for the payment, and declares FK001 as 0', () => {
    const xml = generateAGIXml(company, [ejUlagSAEmployee], totals)
    expect(xml).not.toContain('faltkod="011"')
    // Teknisk beskrivning 5.4: no tax withheld on FK131 means 0 in FK001.
    expect(xml).toContain('<gem:AvdrPrelSkatt faltkod="001">0</gem:AvdrPrelSkatt>')
  })

  it('declares every benefit in its ej-UlagSA field, never the UlagAG one (crm#1372)', () => {
    // Fältlista 1.1.18.1: FK132 övriga förmåner (housing amount included),
    // FK133 bil, FK134 drivmedel, FK137/FK138 housing flags.
    const withBenefits: AGIEmployeeData = {
      ...ejUlagSAEmployee,
      grossSalary: 600,
      benefitOther: 450,
      benefitCar: 900,
      benefitFuel: 120,
      housingBenefit: 'smahus',
    }
    const xml = generateAGIXml(company, [withBenefits], totals)
    expect(xml).toContain('<gem:KontantErsattningEjUlagSA faltkod="131">600</gem:KontantErsattningEjUlagSA>')
    expect(xml).toContain('<gem:SkatteplOvrigaFormanerEjUlagSA faltkod="132">450</gem:SkatteplOvrigaFormanerEjUlagSA>')
    expect(xml).toContain('<gem:SkatteplBilformanEjUlagSA faltkod="133">900</gem:SkatteplBilformanEjUlagSA>')
    expect(xml).toContain('<gem:DrivmVidBilformanEjUlagSA faltkod="134">120</gem:DrivmVidBilformanEjUlagSA>')
    expect(xml).toContain('<gem:BostadsformanSmahusEjUlagSA faltkod="137">1</gem:BostadsformanSmahusEjUlagSA>')
    for (const fk of ['011', '012', '013', '018', '041', '043']) {
      expect(xml).not.toContain(`faltkod="${fk}"`)
    }
  })

  it('keeps the default underlag on FK011/FK012/FK013/FK018/FK043', () => {
    const regular: AGIEmployeeData = {
      ...ejUlagSAEmployee,
      underlag: undefined,
      grossSalary: 600,
      benefitOther: 450,
      benefitCar: 900,
      benefitFuel: 120,
      housingBenefit: 'ej_smahus',
    }
    const xml = generateAGIXml(company, [regular], totals)
    expect(xml).toContain('<gem:KontantErsattningUlagAG faltkod="011">600</gem:KontantErsattningUlagAG>')
    expect(xml).toContain('<gem:SkatteplOvrigaFormanerUlagAG faltkod="012">450</gem:SkatteplOvrigaFormanerUlagAG>')
    expect(xml).toContain('<gem:SkatteplBilformanUlagAG faltkod="013">900</gem:SkatteplBilformanUlagAG>')
    expect(xml).toContain('<gem:DrivmVidBilformanUlagAG faltkod="018">120</gem:DrivmVidBilformanUlagAG>')
    expect(xml).toContain('<gem:BostadsformanEjSmahusUlagAG faltkod="043">1</gem:BostadsformanEjSmahusUlagAG>')
    for (const fk of ['131', '132', '133', '134', '137', '138']) {
      expect(xml).not.toContain(`faltkod="${fk}"`)
    }
  })
})

describe('generateAGIXml: F-skatt payee IU (FK125, #82)', () => {
  // Bilaga Fältlista 1.1.18.1 FK125: "Det kan till exempel vara inkomst av
  // tjänst för mottagare med F-skatt". Underlag for the recipient's
  // egenavgifter (SAL 3 kap. 8 §), not FK131 (no underlag for SA at all).
  const fSkattEmployee: AGIEmployeeData = {
    personnummer: 'emp2_encrypted',
    specificationNumber: 3,
    grossSalary: 15000,
    taxWithheld: 0,
    avgifterBasis: 0,
    underlag: 'egenavgifter',
    benefitOther: 1200,
    benefitCar: 900,
    benefitFuel: 120,
    housingBenefit: 'smahus',
  }

  it('declares cash in FK125 and every benefit in its UlagEA field', () => {
    const xml = generateAGIXml(company, [fSkattEmployee], totals)
    expect(xml).toContain('<gem:KontantErsattningUlagEA faltkod="125">15000</gem:KontantErsattningUlagEA>')
    expect(xml).toContain('<gem:SkatteplOvrigaFormanerUlagEA faltkod="126">1200</gem:SkatteplOvrigaFormanerUlagEA>')
    expect(xml).toContain('<gem:SkatteplBilformanUlagEA faltkod="127">900</gem:SkatteplBilformanUlagEA>')
    expect(xml).toContain('<gem:DrivmVidBilformanUlagEA faltkod="128">120</gem:DrivmVidBilformanUlagEA>')
    // S_157: FK123/FK124 need FK126, which carries the housing amount.
    expect(xml).toContain('<gem:BostadsformanSmahusUlagEA faltkod="123">1</gem:BostadsformanSmahusUlagEA>')
    expect(xml).toContain('<gem:AvdrPrelSkatt faltkod="001">0</gem:AvdrPrelSkatt>')
    for (const fk of ['011', '012', '013', '018', '041', '131', '132', '133', '134', '137']) {
      expect(xml).not.toContain(`faltkod="${fk}"`)
    }
  })

  it('uses FK124 for a housing benefit outside a småhus', () => {
    const xml = generateAGIXml(company, [{ ...fSkattEmployee, housingBenefit: 'ej_smahus' }], totals)
    expect(xml).toContain('<gem:BostadsformanEjSmahusUlagEA faltkod="124">1</gem:BostadsformanEjSmahusUlagEA>')
    expect(xml).not.toContain('faltkod="123"')
  })
})

describe('generateAGIXml: FK048 only next to a benefit S_017 accepts (#82)', () => {
  // Kontroll S_017 (Bilaga Kontroller 1.1.18.1): "Om FK048 finns måste FK012
  // eller FK013 eller FK132 eller FK133 eller FK126 eller FK127 finnas".
  const S_017_FIELDS = ['012', '013', '132', '133', '126', '127']
  const base: AGIEmployeeData = {
    personnummer: 'emp1_encrypted',
    specificationNumber: 1,
    grossSalary: 30000,
    taxWithheld: 9000,
    avgifterBasis: 30000,
    benefitsAdjusted: true,
  }
  const FK048 = '<gem:FormanHarJusterats faltkod="048">1</gem:FormanHarJusterats>'

  function passesS017(xml: string): boolean {
    return !xml.includes('faltkod="048"') || S_017_FIELDS.some((fk) => xml.includes(`faltkod="${fk}"`))
  }

  const cases: Array<[string, AGIEmployeeData, string]> = [
    ['an employee with kost (FK012)', { ...base, benefitOther: 1200 }, '012'],
    ['an employee with bilförmån (FK013)', { ...base, benefitCar: 4000 }, '013'],
    ['an F-skatt payee with kost (FK126)', { ...base, underlag: 'egenavgifter', benefitOther: 1200 }, '126'],
    ['an F-skatt payee with bilförmån (FK127)', { ...base, underlag: 'egenavgifter', benefitCar: 4000 }, '127'],
    ['pay with no avgiftsunderlag and kost (FK132)', { ...base, underlag: 'ej_socialavgifter', benefitOther: 450 }, '132'],
    ['pay with no avgiftsunderlag and bilförmån (FK133)', { ...base, underlag: 'ej_socialavgifter', benefitCar: 4000 }, '133'],
  ]
  for (const [label, emp, field] of cases) {
    it(`emits FK048 for ${label}`, () => {
      const xml = generateAGIXml(company, [emp], totals)
      expect(xml).toContain(FK048)
      expect(xml).toContain(`faltkod="${field}"`)
      expect(passesS017(xml)).toBe(true)
    })
  }

  const without: Array<[string, AGIEmployeeData]> = [
    ['cash only', base],
    ['only drivmedel (FK018 is not in S_017)', { ...base, benefitFuel: 600 }],
    ['an F-skatt payee with cash only', { ...base, underlag: 'egenavgifter' }],
    ['pay with no avgiftsunderlag and no benefit', { ...base, underlag: 'ej_socialavgifter' }],
  ]
  for (const [label, emp] of without) {
    it(`drops FK048 for ${label}, which S_017 would reject`, () => {
      const xml = generateAGIXml(company, [emp], totals)
      expect(xml).not.toContain('faltkod="048"')
      expect(passesS017(xml)).toBe(true)
    })
  }

  it('never emits FK048 when no decision is recorded', () => {
    const xml = generateAGIXml(company, [{ ...base, benefitsAdjusted: false, benefitOther: 1200 }], totals)
    expect(xml).not.toContain('faltkod="048"')
  })
})

describe('generateAGIXml: a benefit paid in full by nettolöneavdrag is declared as 0', () => {
  // Teknisk beskrivning 1.1.18.2 avsnitt 5.3: the field "ska ändå redovisas"
  // with the value 0. Undefined means no such benefit and stays out.
  const base: AGIEmployeeData = {
    personnummer: 'emp1_encrypted',
    specificationNumber: 1,
    grossSalary: 30000,
    taxWithheld: 9000,
    avgifterBasis: 30000,
  }

  it('emits FK013 = 0 and FK012 = 0 for a benefit valued at 0', () => {
    const xml = generateAGIXml(company, [{ ...base, benefitCar: 0, benefitOther: 0 }], totals)
    expect(xml).toContain('<gem:SkatteplBilformanUlagAG faltkod="013">0</gem:SkatteplBilformanUlagAG>')
    expect(xml).toContain('<gem:SkatteplOvrigaFormanerUlagAG faltkod="012">0</gem:SkatteplOvrigaFormanerUlagAG>')
  })

  it('uses the family field for the 0 as well (FK127 for an F-skatt payee, FK133 with no avgiftsunderlag)', () => {
    expect(generateAGIXml(company, [{ ...base, underlag: 'egenavgifter', benefitCar: 0 }], totals)).toContain(
      '<gem:SkatteplBilformanUlagEA faltkod="127">0</gem:SkatteplBilformanUlagEA>',
    )
    expect(generateAGIXml(company, [{ ...base, underlag: 'ej_socialavgifter', benefitCar: 0 }], totals)).toContain(
      '<gem:SkatteplBilformanEjUlagSA faltkod="133">0</gem:SkatteplBilformanEjUlagSA>',
    )
  })

  it('leaves both fields out when there is no benefit', () => {
    const xml = generateAGIXml(company, [base], totals)
    expect(xml).not.toContain('faltkod="012"')
    expect(xml).not.toContain('faltkod="013"')
  })

  it('keeps FK048 next to an FK013 of 0: the field is there, so S_017 holds', () => {
    const xml = generateAGIXml(company, [{ ...base, benefitCar: 0, benefitsAdjusted: true }], totals)
    expect(xml).toContain('<gem:FormanHarJusterats faltkod="048">1</gem:FormanHarJusterats>')
  })
})

describe('generateAGIXml: FK050 Bilersattning and FK051 Traktamente flags', () => {
  // Bilaga Fältlista 1.1.18.1: FK050 and FK051 are KRYSS fields, "Sätts till
  // 1 eller true om ikryssad, annars utelämnas fältet".
  const base: AGIEmployeeData = {
    personnummer: 'emp1_encrypted',
    specificationNumber: 1,
    grossSalary: 30000,
    taxWithheld: 9000,
    avgifterBasis: 30000,
  }
  const FK050 = '<gem:Bilersattning faltkod="050">1</gem:Bilersattning>'
  const FK051 = '<gem:Traktamente faltkod="051">1</gem:Traktamente>'

  it('emits FK050 when a tax-free milersättning was paid', () => {
    const xml = generateAGIXml(company, [{ ...base, mileageAllowancePaid: true }], totals)
    expect(xml).toContain(FK050)
    expect(xml).not.toContain('faltkod="051"')
  })

  it('emits FK051 when a tax-free traktamente was paid', () => {
    const xml = generateAGIXml(company, [{ ...base, traktamentePaid: true }], totals)
    expect(xml).toContain(FK051)
    expect(xml).not.toContain('faltkod="050"')
  })

  it('emits both flags once each when both were paid', () => {
    const xml = generateAGIXml(company, [{ ...base, mileageAllowancePaid: true, traktamentePaid: true }], totals)
    expect(xml.split(FK050)).toHaveLength(2)
    expect(xml.split(FK051)).toHaveLength(2)
  })

  it('leaves both fields out when neither was paid', () => {
    for (const emp of [base, { ...base, mileageAllowancePaid: false, traktamentePaid: false }]) {
      const xml = generateAGIXml(company, [emp], totals)
      expect(xml).not.toContain('faltkod="050"')
      expect(xml).not.toContain('faltkod="051"')
    }
  })

  it('sets the flags in every underlag family: they have no UlagEA or EjUlagSA variant', () => {
    for (const underlag of ['egenavgifter', 'ej_socialavgifter'] as const) {
      const xml = generateAGIXml(
        company,
        [{ ...base, underlag, mileageAllowancePaid: true, traktamentePaid: true }],
        totals,
      )
      expect(xml).toContain(FK050)
      expect(xml).toContain(FK051)
    }
  })

  it('keeps a borttag IU free of the flags (S_003: identity fields only)', () => {
    const xml = generateAGIXml(
      company,
      [{ ...base, removed: true, mileageAllowancePaid: true, traktamentePaid: true }],
      totals,
    )
    expect(xml).toContain('<gem:Borttag faltkod="205">1</gem:Borttag>')
    expect(xml).not.toContain('faltkod="050"')
    expect(xml).not.toContain('faltkod="051"')
  })
})

describe('generateAGIXml: every IU carries a skattefält (kontroll S_183, crm#1265)', () => {
  // S_183: without FK205 at least one of FK001, FK274, FK275, FK094, FK114,
  // FK253, FK276 must have a value; S_175: at most one of them.
  const SKATTEFALT = ['001', '274', '275', '094', '114', '253', '276']

  function iuBlocks(xml: string): string[] {
    return xml.split('<gem:IU>').slice(1).map((b) => b.split('</gem:IU>')[0])
  }

  function skattefaltIn(iu: string): string[] {
    return SKATTEFALT.filter((fk) => iu.includes(`faltkod="${fk}"`))
  }

  const zeroTaxEmployee: AGIEmployeeData = {
    personnummer: 'emp2_encrypted',
    specificationNumber: 2,
    grossSalary: 9000,
    taxWithheld: 0,
    avgifterBasis: 9000,
  }

  it('declares FK001 as 0 for a paid employee with no tax withheld', () => {
    const [iu] = iuBlocks(generateAGIXml(company, [zeroTaxEmployee], totals))
    expect(iu).toContain('<gem:KontantErsattningUlagAG faltkod="011">9000</gem:KontantErsattningUlagAG>')
    expect(iu).toContain('<gem:AvdrPrelSkatt faltkod="001">0</gem:AvdrPrelSkatt>')
  })

  it('declares FK001 as 0 on a benefit-only IU with no cash and no tax', () => {
    const benefitOnly: AGIEmployeeData = {
      personnummer: 'emp2_encrypted',
      specificationNumber: 2,
      grossSalary: 0,
      taxWithheld: 0,
      avgifterBasis: 0,
      benefitOther: 1200,
    }
    const [iu] = iuBlocks(generateAGIXml(company, [benefitOnly], totals))
    expect(iu).not.toContain('faltkod="011"')
    expect(iu).toContain('<gem:SkatteplOvrigaFormanerUlagAG faltkod="012">1200</gem:SkatteplOvrigaFormanerUlagAG>')
    expect(iu).toContain('<gem:AvdrPrelSkatt faltkod="001">0</gem:AvdrPrelSkatt>')
  })

  it('declares FK001 as 0 when the withheld tax is below one krona', () => {
    const [iu] = iuBlocks(generateAGIXml(company, [{ ...zeroTaxEmployee, taxWithheld: 0.6 }], totals))
    expect(iu).toContain('<gem:AvdrPrelSkatt faltkod="001">0</gem:AvdrPrelSkatt>')
  })

  it('leaves a normal employee unchanged: FK011 and the withheld FK001', () => {
    const [iu] = iuBlocks(generateAGIXml(company, [employees[0]], totals))
    expect(iu).toContain('<gem:KontantErsattningUlagAG faltkod="011">40000</gem:KontantErsattningUlagAG>')
    expect(iu).toContain('<gem:AvdrPrelSkatt faltkod="001">12000</gem:AvdrPrelSkatt>')
  })

  it('keeps a borttag IU free of FK001 (S_003: identity fields only)', () => {
    const removed: AGIEmployeeData = { ...zeroTaxEmployee, removed: true }
    const [iu] = iuBlocks(generateAGIXml(company, [removed], totals))
    expect(iu).toContain('<gem:Borttag faltkod="205">1</gem:Borttag>')
    expect(skattefaltIn(iu)).toEqual([])
  })

  it('gives every non-borttag IU of a mixed roster exactly one skattefält', () => {
    const roster: AGIEmployeeData[] = [
      ...employees,
      { ...zeroTaxEmployee, specificationNumber: 3 },
      { ...zeroTaxEmployee, specificationNumber: 4, grossSalary: 5000, avgifterBasis: 0, underlag: 'ej_socialavgifter' },
      { ...zeroTaxEmployee, specificationNumber: 5, removed: true },
    ]
    const ius = iuBlocks(generateAGIXml(company, roster, totals))
    expect(ius).toHaveLength(5)
    for (const iu of ius) {
      const expected = iu.includes('faltkod="205"') ? [] : ['001']
      expect(skattefaltIn(iu)).toEqual(expected)
    }
  })
})

describe('generateAGIXml: fail-fast on missing data', () => {
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

describe('findMissingCompanyData: the check generation and staging share (crm#1435)', () => {
  it('finds nothing when the company data is complete', () => {
    expect(findMissingCompanyData(company)).toBeNull()
  })

  it('names each missing field and the settings label it is filled in under', () => {
    const gap = findMissingCompanyData({ ...company, orgNumber: '', contactPhone: ' ' })
    expect(gap).toBeInstanceOf(AGIIncompleteDataError)
    expect(gap?.missingFields).toEqual(['organisationsnummer', 'telefon'])
    expect(gap?.message).toBe(
      'AGI kan inte genereras, följande uppgifter saknas: organisationsnummer, telefon. ' +
        'Fyll i organisationsnummer under Inställningar → Allmänt; telefon under Inställningar → Moms och skatt → ' +
        'Kontaktperson för skatteärenden (eller Telefon under Inställningar → Allmänt).',
    )
  })
})

describe('buildIndividuppgifterSnapshot', () => {
  it('stores no personnummer, in clear or sealed: FK570 rides on specificationNumber (#58)', () => {
    const snapshot = buildIndividuppgifterSnapshot(employees)
    expect(snapshot).toEqual([
      { specificationNumber: 1, grossSalary: 40000, taxWithheld: 12000, avgifterBasis: 40000, removed: false },
      { specificationNumber: 2, grossSalary: 35000, taxWithheld: 10500, avgifterBasis: 35000, removed: false },
    ])
    const stored = JSON.stringify(snapshot)
    expect(maskPersonnummerInText(stored)).toBe(stored)
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

describe('generateAGIXml: Frånvarouppgift', () => {
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
    // event object: they are NOT recomputed from array index.
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

  it('clamps hours into the spec range (0.01-24.00)', () => {
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

  it('emits required fields per Frånvarouppgift (AgRegistreradId, RedovisningsPeriod, FranvaroDatum, BetalningsmottagarId, Specifikationsnummer, FranvaroTyp)', () => {
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
    expect(block).toContain('faltkod="823"') // FranvaroTyp
  })

  // PH 217: Skatteverket rejected every file with frånvaro ("Det angivna
  // elementnamnet FranvaroChoice är inte giltigt"). Franvarouppgift is an
  // xs:all in komponent schema 1.1 (arbetsgivardeklaration_component_1.1.xsd):
  // FranvaroTyp and the timmar field are direct children, there is no
  // wrapper element. The expected blocks mirror Skatteverket's example
  // files 17 and 18 (Bilaga Exempelfiler 1.1.18.1).
  it('emits FranvaroTyp as a direct child, never inside a FranvaroChoice wrapper (PH 217)', () => {
    const xml = generateAGIXml(company, employeesWithAbsence, totals)
    expect(xml).not.toContain('FranvaroChoice')

    const blocks = xml.match(/ {2}<gem:Franvarouppgift>\n[\s\S]*?\n {2}<\/gem:Franvarouppgift>/g) ?? []
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toBe([
      '  <gem:Franvarouppgift>',
      '    <gem:AgRegistreradId faltkod="201">165561234567</gem:AgRegistreradId>',
      '    <gem:RedovisningsPeriod faltkod="006">202604</gem:RedovisningsPeriod>',
      '    <gem:FranvaroDatum faltkod="821">2026-04-15</gem:FranvaroDatum>',
      '    <gem:BetalningsmottagarId faltkod="215">199001011234</gem:BetalningsmottagarId>',
      '    <gem:FranvaroSpecifikationsnummer faltkod="822">1</gem:FranvaroSpecifikationsnummer>',
      '    <gem:FranvaroTyp faltkod="823">TILLFALLIG_FORALDRAPENNING</gem:FranvaroTyp>',
      '    <gem:FranvaroTimmarTFP faltkod="825">8</gem:FranvaroTimmarTFP>',
      '  </gem:Franvarouppgift>',
    ].join('\n'))
    expect(blocks[2]).toBe([
      '  <gem:Franvarouppgift>',
      '    <gem:AgRegistreradId faltkod="201">165561234567</gem:AgRegistreradId>',
      '    <gem:RedovisningsPeriod faltkod="006">202604</gem:RedovisningsPeriod>',
      '    <gem:FranvaroDatum faltkod="821">2026-04-20</gem:FranvaroDatum>',
      '    <gem:BetalningsmottagarId faltkod="215">198506159876</gem:BetalningsmottagarId>',
      '    <gem:FranvaroSpecifikationsnummer faltkod="822">1</gem:FranvaroSpecifikationsnummer>',
      '    <gem:FranvaroTyp faltkod="823">FORALDRAPENNING</gem:FranvaroTyp>',
      '    <gem:FranvaroTimmarFP faltkod="827">8</gem:FranvaroTimmarFP>',
      '  </gem:Franvarouppgift>',
    ].join('\n'))
  })

  it('omits the section entirely when no employee has absenceEvents', () => {
    const xml = generateAGIXml(company, employees, totals)
    expect(xml).not.toContain('Franvarouppgift')
  })
})

describe('generateAGIXml: nolldeklaration (HU-only, no IU)', () => {
  const zeroTotals: AGITotals = {
    totalTax: 0,
    totalAvgifterBasis: 0,
    totalAvgifterAmount: 0,
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

  it('omits every zero HU total field (FK497/FK487)', () => {
    const xml = generateAGIXml(company, [], zeroTotals)
    expect(xml).not.toContain('faltkod="497"') // SummaSkatteavdr
    expect(xml).not.toContain('faltkod="487"') // SummaArbAvgSlf
    expect(xml).not.toContain('faltkod="499"') // TotalSjuklonekostnad: retired, never emitted
  })

  it('still validates required company data for a nolldeklaration', () => {
    expect(() =>
      generateAGIXml({ ...company, orgNumber: '' }, [], zeroTotals),
    ).toThrow(AGIIncompleteDataError)
  })
})
