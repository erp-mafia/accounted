import { describe, expect, it } from 'vitest'
import { defaultGronTeknikWorkType, deriveRequiresHousing } from '../invoice-editor-flow'

describe('deriveRequiresHousing: grön teknik names the property like ROT', () => {
  it('requires housing for a grön teknik line once it carries an amount', () => {
    expect(deriveRequiresHousing({ hasRotLine: false, hasGronTeknikLine: true, deductionTotal: 1875 })).toBe(true)
    expect(deriveRequiresHousing({ hasRotLine: false, hasGronTeknikLine: true, deductionTotal: 0 })).toBe(false)
    expect(deriveRequiresHousing({ hasRotLine: false, hasGronTeknikLine: false, deductionTotal: 500 })).toBe(false)
  })
})

describe('defaultGronTeknikWorkType: a new grön teknik row starts on the invoice\'s installation type', () => {
  const rows = [
    { deduction_type: 'gron_teknik', work_type: 'INSTALLATION_SOLCELLER' },
    { deduction_type: null, work_type: null },
    { deduction_type: 'gron_teknik', work_type: null },
  ]

  it('takes the type another grön teknik row already carries', () => {
    expect(defaultGronTeknikWorkType(rows, 2)).toBe('INSTALLATION_SOLCELLER')
    expect(defaultGronTeknikWorkType(rows, 1)).toBe('INSTALLATION_SOLCELLER')
  })

  it('never reads the row itself, ROT/RUT codes or unknown codes', () => {
    expect(defaultGronTeknikWorkType(rows, 0)).toBeNull()
    expect(
      defaultGronTeknikWorkType(
        [
          { deduction_type: 'rot', work_type: 'EL' },
          { deduction_type: 'gron_teknik', work_type: 'SOLAR' },
          undefined,
          { deduction_type: 'gron_teknik', work_type: null },
        ],
        3,
      ),
    ).toBeNull()
  })

  it('reads a padded code as its type', () => {
    expect(defaultGronTeknikWorkType([{ deduction_type: 'gron_teknik', work_type: ' INSTALLATION_LADDPUNKT ' }], 1)).toBe(
      'INSTALLATION_LADDPUNKT',
    )
  })
})
