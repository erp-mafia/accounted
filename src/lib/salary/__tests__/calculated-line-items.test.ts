/**
 * Which payslip lines the calculation owns (lib/salary/calculated-line-items.ts):
 * the line commands refuse hand edits to exactly these, and run-calculation
 * reads every other line as manual (#3185).
 */
import { describe, expect, it } from 'vitest'
import {
  DERIVED_ABSENCE_TYPES,
  DERIVED_PREMIUM_TYPES,
  isCalculatedLine,
  isCalculatedLineType,
  VACATION_COMPENSATION_SOURCE,
} from '../calculated-line-items'

describe('isCalculatedLineType', () => {
  it('covers every absence and shift-premium type the calculation derives', () => {
    for (const type of [...DERIVED_ABSENCE_TYPES, ...DERIVED_PREMIUM_TYPES]) {
      expect(isCalculatedLineType(type), type).toBe(true)
    }
  })

  it('leaves the types a person enters by hand alone', () => {
    for (const type of ['overtime', 'other', 'bonus', 'commission', 'semesterersattning', 'vacation', 'correction']) {
      expect(isCalculatedLineType(type), type).toBe(false)
    }
  })
})

describe('isCalculatedLine', () => {
  it('is true for a derived type, a förmån row, a recurring-line row, the engine semesterersättning and öresavrundning', () => {
    expect(isCalculatedLine({ item_type: 'ob_weekend' })).toBe(true)
    expect(isCalculatedLine({ item_type: 'benefit_car', source_benefit_id: 'b-1' })).toBe(true)
    expect(isCalculatedLine({ item_type: 'net_deduction_union', source_recurring_line_id: 'r-1' })).toBe(true)
    expect(isCalculatedLine({ item_type: 'semesterersattning', calculation_source: VACATION_COMPENSATION_SOURCE })).toBe(true)
    expect(isCalculatedLine({ item_type: 'oresavrundning' })).toBe(true)
  })

  it('is false for a manual line, including a hand-entered semesterersättning', () => {
    expect(isCalculatedLine({ item_type: 'bonus' })).toBe(false)
    expect(isCalculatedLine({ item_type: 'overtime', source_benefit_id: null, source_recurring_line_id: null })).toBe(false)
    expect(isCalculatedLine({ item_type: 'semesterersattning', calculation_source: null })).toBe(false)
  })
})
