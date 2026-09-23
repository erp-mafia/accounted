import { describe, it, expect } from 'vitest'
import { checkExpenseWarnings } from '../expense-warnings'

describe('checkExpenseWarnings: representation meals', () => {
  it('states that the VAT deduction is retained on a 300 kr/person base (2017 reform inverted this before, issue #313)', () => {
    const warnings = checkExpenseWarnings('Lunch med kund på restaurang')
    const representation = warnings.find((w) => w.category === 'Representation')

    expect(representation).toBeDefined()
    expect(representation!.warningLevel).toBe('warning')
    expect(representation!.message).toBe(
      'Måltider kan vara avdragsgilla som representation. Inkomstskatteavdraget togs bort 2017, men momsen är avdragsgill på upp till 300 kr/person (exkl. moms) enligt ML 13 kap 24-25 §§.'
    )
    expect(representation!.legalBasis).toBe('IL 16 kap 2 §, ML 13 kap 24-25 §§')
  })

  it('never claims the VAT deduction was abolished and never cites the repealed ML 1994:200 chapter', () => {
    const warnings = checkExpenseWarnings('Middag på restaurang')
    const representation = warnings.find((w) => w.category === 'Representation')

    expect(representation).toBeDefined()
    // The pre-fix text said 'Momsen är inte avdragsgill sedan 2017', which is
    // legally inverted: Prop. 2016/17:1 abolished the income-tax deduction but
    // retained the VAT deduction (now ML 2023:200, 13 kap 24-25 §§).
    expect(representation!.message).not.toMatch(/momsen är inte avdragsgill/i)
    expect(representation!.legalBasis).not.toMatch(/ML 8:9/)
  })

  it('triggers on restaurant, lunch, dinner, and fika descriptions', () => {
    for (const description of ['Restaurang Prinsen', 'lunch', 'middag', 'fika med teamet']) {
      const warnings = checkExpenseWarnings(description)
      expect(warnings.some((w) => w.category === 'Representation')).toBe(true)
    }
  })

  it('does not trigger the representation warning for unrelated descriptions', () => {
    const warnings = checkExpenseWarnings('Adobe software subscription')
    expect(warnings.some((w) => w.category === 'Representation')).toBe(false)
  })
})
