import { describe, it, expect, vi } from 'vitest'
import { AGIKontrolleraIUSchema } from '../agi/kontrollera-schemas'
import { generateAGIXml, type AGIEmployeeData, type AGIUnderlag } from '../agi/xml-generator'

vi.mock('../personnummer', () => ({
  decryptPersonnummer: () => '198506159876',
}))

const IU = {
  agRegistreradId: '165560000167',
  redovisningsPeriod: '202609',
  betalningsmottagarId: '198001019876',
  specifikationsnummer: 1,
  kontantErsattningUlagAG: 35000,
  avdrPrelSkatt: 8200,
}

describe('AGIKontrolleraIUSchema: växa-stöd fields (FK062/FK063)', () => {
  it('refuses vaxaStod from redovisningsperiod 202601 with the rule, in Swedish', () => {
    const parsed = AGIKontrolleraIUSchema.safeParse({ ...IU, redovisningsPeriod: '202601', vaxaStod: true })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues).toHaveLength(1)
    expect(parsed.error.issues[0].path).toEqual(['vaxaStod'])
    expect(parsed.error.issues[0].message).toContain('redovisas inte i arbetsgivardeklarationen från redovisningsperiod 202601')
    expect(parsed.error.issues[0].message).toContain('ansök om återbetalning')
  })

  it('refuses forstaAnstalld for a later period too', () => {
    const parsed = AGIKontrolleraIUSchema.safeParse({ ...IU, forstaAnstalld: true })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.map((i) => i.path)).toEqual([['forstaAnstalld']])
  })

  it('accepts an explicit false and an IU without the fields', () => {
    expect(AGIKontrolleraIUSchema.safeParse({ ...IU, vaxaStod: false, forstaAnstalld: false }).success).toBe(true)
    expect(AGIKontrolleraIUSchema.safeParse(IU).success).toBe(true)
  })

  it('still accepts the fields for 202512, the last period they were valid in', () => {
    expect(AGIKontrolleraIUSchema.safeParse({ ...IU, redovisningsPeriod: '202512', vaxaStod: true }).success).toBe(true)
    expect(AGIKontrolleraIUSchema.safeParse({ ...IU, redovisningsPeriod: '202512', forstaAnstalld: true }).success).toBe(true)
  })

  it('keeps them mutually exclusive in the periods they were valid in', () => {
    const parsed = AGIKontrolleraIUSchema.safeParse({
      ...IU,
      redovisningsPeriod: '202512',
      forstaAnstalld: true,
      vaxaStod: true,
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues[0].message).toContain('ömsesidigt uteslutande')
  })
})

describe('AGIKontrolleraIUSchema: kostförmån has no field of its own (#81)', () => {
  // Skatteverket's schema and AGI API define no kostförmån property: kost is
  // summed into skatteplOvrigaFormanerUlagAG (FK012) / EjUlagSA (FK132).
  it('refuses kostformanUlagAG and kostformanEjUlagSA locally instead of forwarding them', () => {
    for (const field of ['kostformanUlagAG', 'kostformanEjUlagSA']) {
      const parsed = AGIKontrolleraIUSchema.safeParse({ ...IU, [field]: 1200 })
      expect(parsed.success, field).toBe(false)
      if (parsed.success) continue
      expect(parsed.error.issues[0].code).toBe('unrecognized_keys')
    }
  })

  it('accepts kost declared in FK012 and FK132', () => {
    expect(AGIKontrolleraIUSchema.safeParse({ ...IU, skatteplOvrigaFormanerUlagAG: 1200 }).success).toBe(true)
    expect(AGIKontrolleraIUSchema.safeParse({ ...IU, skatteplOvrigaFormanerEjUlagSA: 1200 }).success).toBe(true)
  })
})

describe('AGIKontrolleraIUSchema: an F-skatt payee\'s IU in FK123-FK128 (#91)', () => {
  // The AGI declares an F-skatt payee's pay in FK125 with benefits in
  // FK126/FK127/FK128 and the housing flags FK123/FK124 (#82). The pre-check
  // must accept exactly what the generator writes, so these tests turn a
  // generated IU into its kontrollera JSON (property = the XML element name
  // with a lower-case first letter, Tjänstebeskrivning 8.2) and parse it.
  const COMPANY = {
    orgNumber: '556123-4567',
    entityType: 'aktiebolag' as const,
    companyName: 'Test AB',
    periodYear: 2026,
    periodMonth: 9,
    contactName: 'Anna Admin',
    contactPhone: '0701234567',
    contactEmail: 'anna@test.se',
  }
  const TOTALS = { totalTax: 0, totalAvgifterBasis: 0, totalAvgifterAmount: 0, avgifterByCategory: {} }
  const KRYSS = new Set([
    'BostadsformanSmahusUlagAG',
    'BostadsformanEjSmahusUlagAG',
    'BostadsformanSmahusUlagEA',
    'BostadsformanEjSmahusUlagEA',
    'BostadsformanSmahusEjUlagSA',
    'BostadsformanEjSmahusEjUlagSA',
    'FormanHarJusterats',
    'Borttag',
  ])
  const IDENTITY_STRINGS = new Set(['AgRegistreradId', 'BetalningsmottagarId', 'RedovisningsPeriod'])

  function generatedIuPayload(employee: AGIEmployeeData): Record<string, unknown> {
    const xml = generateAGIXml(COMPANY, [employee], TOTALS)
    const iu = xml.split('<gem:IU>')[1].split('</gem:IU>')[0]
    const payload: Record<string, unknown> = {}
    for (const [, element, value] of iu.matchAll(/<gem:(\w+) faltkod="\d+">([^<]*)<\/gem:\1>/g)) {
      const property = element[0].toLowerCase() + element.slice(1)
      payload[property] = KRYSS.has(element) ? value === '1' : IDENTITY_STRINGS.has(element) ? value : Number(value)
    }
    return payload
  }

  const F_SKATT_PAYEE: AGIEmployeeData = {
    personnummer: 'encrypted',
    specificationNumber: 3,
    grossSalary: 15000,
    taxWithheld: 0,
    avgifterBasis: 0,
    underlag: 'egenavgifter',
    benefitCar: 4000,
    benefitFuel: 600,
    housingBenefit: 'smahus',
    benefitOther: 5200,
    benefitsAdjusted: true,
  }

  it('accepts a generated IU for an F-skatt payee with cash, bil, drivmedel and bostad', () => {
    const payload = generatedIuPayload(F_SKATT_PAYEE)
    expect(payload).toEqual({
      agRegistreradId: '165561234567',
      betalningsmottagarId: '198506159876',
      redovisningsPeriod: '202609',
      specifikationsnummer: 3,
      kontantErsattningUlagEA: 15000,
      avdrPrelSkatt: 0,
      skatteplBilformanUlagEA: 4000,
      drivmVidBilformanUlagEA: 600,
      bostadsformanSmahusUlagEA: true,
      skatteplOvrigaFormanerUlagEA: 5200,
      formanHarJusterats: true,
    })
    const parsed = AGIKontrolleraIUSchema.safeParse(payload)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('accepts the ej-småhus flag FK124 and a cash-only F-skatt IU', () => {
    for (const employee of [
      { ...F_SKATT_PAYEE, housingBenefit: 'ej_smahus' as const },
      { ...F_SKATT_PAYEE, benefitCar: undefined, benefitFuel: undefined, housingBenefit: undefined, benefitOther: undefined, benefitsAdjusted: false },
    ]) {
      const payload = generatedIuPayload(employee)
      expect(AGIKontrolleraIUSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(true)
    }
    expect(generatedIuPayload({ ...F_SKATT_PAYEE, housingBenefit: 'ej_smahus' })).toMatchObject({
      bostadsformanEjSmahusUlagEA: true,
    })
  })

  it('accepts what the generator writes in every underlag family', () => {
    for (const underlag of ['arbetsgivaravgifter', 'egenavgifter', 'ej_socialavgifter'] satisfies AGIUnderlag[]) {
      const payload = generatedIuPayload({ ...F_SKATT_PAYEE, underlag, taxWithheld: 4500 })
      const parsed = AGIKontrolleraIUSchema.safeParse(payload)
      expect(parsed.success, `${underlag}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
    }
  })

  it('refuses a malformed F-skatt IU locally instead of forwarding it', () => {
    const good = generatedIuPayload(F_SKATT_PAYEE)
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['öre in FK125', { ...good, kontantErsattningUlagEA: 15000.5 }, 'kontantErsattningUlagEA'],
      ['a negative FK127', { ...good, skatteplBilformanUlagEA: -4000 }, 'skatteplBilformanUlagEA'],
      ['FK128 as a string', { ...good, drivmVidBilformanUlagEA: '600' }, 'drivmVidBilformanUlagEA'],
      ['FK123 as an amount', { ...good, bostadsformanSmahusUlagEA: 5200 }, 'bostadsformanSmahusUlagEA'],
      ['FK124 as a string', { ...good, bostadsformanEjSmahusUlagEA: 'ja' }, 'bostadsformanEjSmahusUlagEA'],
      ['FK126 above the BELOPP10 cap', { ...good, skatteplOvrigaFormanerUlagEA: 10_000_000_000 }, 'skatteplOvrigaFormanerUlagEA'],
    ]
    for (const [label, payload, field] of cases) {
      const parsed = AGIKontrolleraIUSchema.safeParse(payload)
      expect(parsed.success, label).toBe(false)
      if (parsed.success) continue
      expect(parsed.error.issues.map((i) => i.path[0]), label).toContain(field)
    }
  })

  it('refuses a misspelt UlagEA property as unknown', () => {
    const parsed = AGIKontrolleraIUSchema.safeParse({ ...IU, kontantErsattningUlagEa: 15000 })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues[0].code).toBe('unrecognized_keys')
  })
})
