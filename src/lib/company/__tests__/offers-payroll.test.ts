import { describe, expect, it } from 'vitest'
import { ENTITY_TYPES } from '@/lib/company/entity-type'
import { offersPayroll } from '@/lib/company/offers-payroll'

describe('offersPayroll', () => {
  // Every legal form under both states of company_settings.pays_salaries.
  it.each([
    ['aktiebolag', false, true],
    ['aktiebolag', true, true],
    ['ideell_forening', false, true],
    ['ideell_forening', true, true],
    ['enskild_firma', false, false],
    ['enskild_firma', true, true],
  ] as const)('%s with pays_salaries=%s -> %s', (entityType, paysSalaries, expected) => {
    expect(offersPayroll(entityType, paysSalaries)).toBe(expected)
  })

  it('covers every legal form in the registry', () => {
    expect([...ENTITY_TYPES].sort()).toEqual(['aktiebolag', 'enskild_firma', 'ideell_forening'])
  })

  it.each([null, undefined, 'handelsbolag', 'AB'])(
    'leaves an unresolved form (%s) to the flag alone',
    (entityType) => {
      expect(offersPayroll(entityType, false)).toBe(false)
      expect(offersPayroll(entityType, null)).toBe(false)
      expect(offersPayroll(entityType, undefined)).toBe(false)
      expect(offersPayroll(entityType, true)).toBe(true)
    },
  )
})
