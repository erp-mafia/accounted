import { describe, it, expect } from 'vitest'
import { AGIKontrolleraIUSchema } from '../agi/kontrollera-schemas'

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
