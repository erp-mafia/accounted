import { describe, it, expect } from 'vitest'
import { resolveEmployerSwitches, type EmployerSwitchEdits } from '../employer-switches'

const UNTOUCHED: EmployerSwitchEdits = { paysSalaries: null, employerRegistered: null, employerSeasonal: null }

// crm#1790: a company with a salaried employee but no answered employer flag
// gets its AGI rows from the employee (isAgiEmployer). Saving the Lön settings
// page must not answer the flag for the person.
describe('resolveEmployerSwitches', () => {
  it('leaves an unanswered employer_registered out of a save that did not touch it', () => {
    const result = resolveEmployerSwitches(
      { pays_salaries: false, employer_registered: null, employer_seasonal: false },
      UNTOUCHED,
    )

    expect(result.employerRegistered).toBe(false)
    expect(result.updates).not.toHaveProperty('employer_registered')
    expect(result.updates).toEqual({ pays_salaries: false, employer_seasonal: false })
  })

  it('leaves it out when the switch shows on from pays_salaries, too', () => {
    const result = resolveEmployerSwitches(
      { pays_salaries: true, employer_registered: null, employer_seasonal: false },
      UNTOUCHED,
    )

    expect(result.employerRegistered).toBe(true)
    expect(result.updates).not.toHaveProperty('employer_registered')
  })

  it('leaves an answered flag alone when the switch is not touched', () => {
    for (const stored of [true, false]) {
      const result = resolveEmployerSwitches(
        { pays_salaries: false, employer_registered: stored, employer_seasonal: false },
        UNTOUCHED,
      )
      expect(result.employerRegistered).toBe(stored)
      expect(result.updates).not.toHaveProperty('employer_registered')
    }
  })

  it('writes an explicit false, and seasonal with it goes off', () => {
    const result = resolveEmployerSwitches(
      { pays_salaries: true, employer_registered: true, employer_seasonal: true },
      { paysSalaries: null, employerRegistered: false, employerSeasonal: null },
    )

    expect(result.employerRegistered).toBe(false)
    expect(result.updates).toEqual({ pays_salaries: true, employer_registered: false, employer_seasonal: false })
  })

  it('writes an explicit true over an unanswered flag', () => {
    const result = resolveEmployerSwitches(
      { pays_salaries: false, employer_registered: null, employer_seasonal: false },
      { paysSalaries: null, employerRegistered: true, employerSeasonal: null },
    )

    expect(result.updates.employer_registered).toBe(true)
  })

  it('writes true when turning pays salaries on also set the switch (the page does both)', () => {
    const result = resolveEmployerSwitches(
      { pays_salaries: false, employer_registered: null, employer_seasonal: false },
      { paysSalaries: true, employerRegistered: true, employerSeasonal: null },
    )

    expect(result.updates).toEqual({ pays_salaries: true, employer_registered: true, employer_seasonal: false })
  })

  it('an unanswered switch follows pays salaries as shown on the page, so it never shows what the save would not keep', () => {
    const result = resolveEmployerSwitches(
      { pays_salaries: true, employer_registered: null, employer_seasonal: false },
      { paysSalaries: false, employerRegistered: null, employerSeasonal: null },
    )

    expect(result.paysSalaries).toBe(false)
    expect(result.employerRegistered).toBe(false)
    expect(result.updates).toEqual({ pays_salaries: false, employer_seasonal: false })
  })

  it('sends seasonal only while the company shows as registered', () => {
    const on = resolveEmployerSwitches(
      { pays_salaries: true, employer_registered: true, employer_seasonal: false },
      { paysSalaries: null, employerRegistered: null, employerSeasonal: true },
    )
    expect(on.updates.employer_seasonal).toBe(true)

    const off = resolveEmployerSwitches(
      { pays_salaries: false, employer_registered: false, employer_seasonal: false },
      { paysSalaries: null, employerRegistered: null, employerSeasonal: true },
    )
    expect(off.employerSeasonal).toBe(true)
    expect(off.updates.employer_seasonal).toBe(false)
  })

  it('reads a missing stored row field as off', () => {
    const result = resolveEmployerSwitches({}, UNTOUCHED)

    expect(result).toMatchObject({ paysSalaries: false, employerRegistered: false, employerSeasonal: false })
    expect(result.updates).toEqual({ pays_salaries: false, employer_seasonal: false })
  })
})
