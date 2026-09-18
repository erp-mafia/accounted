import { describe, expect, it } from 'vitest'
import { assertVacationLineProvenance, isAutomaticVacationLine } from '../calculated-line-items'

describe('vacation calculation provenance', () => {
  it('keeps manual vacation payments regardless of employee vacation rule', () => {
    const manual = { item_type: 'semesterersattning', description: 'Slutsemesterersättning', amount: 2500 }
    expect(isAutomaticVacationLine(manual)).toBe(false)
    expect(() => assertVacationLineProvenance([manual])).not.toThrow()
  })
  it('identifies only engine-owned compensation for replacement', () => {
    const automatic = { item_type: 'semesterersattning', calculation_source: 'vacation_compensation' }
    expect(isAutomaticVacationLine(automatic)).toBe(true)
    expect(isAutomaticVacationLine({ ...automatic, item_type: 'other' })).toBe(false)
  })
  it('blocks ambiguous legacy rows instead of guessing provenance', () => {
    expect(() => assertVacationLineProvenance([{
      item_type: 'semesterersattning', description: 'Semesterersättning', sort_order: 50,
    }])).toThrow('Klassificera')
  })
})
