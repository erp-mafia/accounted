/**
 * Area a of the payroll scenario catalogue: the law baseline, run against
 * the engine (law-baseline.scenarios.ts holds the data and the sources).
 */
import { describe, expect, it, vi } from 'vitest'
import { computeDeclaredAvgifter } from '../../declared-avgifter'
import { procentregelnDayValue } from '../../vacation-days-pay'
import { scenarioTestName } from './catalogue'
import { actualFor, runPayslip } from './harness'
import { LAW_SCENARIOS, type LawScenario } from './law-baseline.scenarios'

// The scenarios carry plaintext personnummer; decryption is the identity so
// the engine's age tiers read them without the legacy-plaintext warning.
vi.mock('@/lib/salary/personnummer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/salary/personnummer')>()
  return { ...actual, decryptPersonnummer: (value: string) => value }
})

function runScenario(s: LawScenario): void {
  switch (s.kind) {
    case 'payslip': {
      const run = runPayslip(s.inputs)
      expect(actualFor(run, s.expected)).toEqual(s.expected)
      return
    }
    case 'procentregeln-day-value': {
      const value = procentregelnDayValue({
        paymentDate: s.inputs.paymentDate,
        basis: 'calendar',
        employmentStart: s.inputs.employmentStart,
        employmentEnd: null,
        vacationDaysPerYear: s.inputs.vacationDaysPerYear,
        vacationPayRate: s.inputs.vacationPayRate,
        payslips: s.inputs.payslips,
      })
      expect(value.known).toBe(true)
      if (value.known) expect({ perDay: value.perDay }).toEqual(s.expected)
      return
    }
    case 'declared-avgifter': {
      const declared = computeDeclaredAvgifter(s.inputs.rows, { standardRate: 0.3142, youthCap: 25000, vaxaCap: null })
      expect({ totalUnderlag: declared.totalUnderlag, totalAmount: declared.totalAmount }).toEqual(s.expected)
      return
    }
  }
}

describe('payroll scenarios, area a: law baseline', () => {
  for (const s of LAW_SCENARIOS) {
    const name = scenarioTestName(s)
    if (s.status === 'todo') it.todo(name)
    // SCENARIO_SHOW_BUGS=1 runs the suspected engine bugs as plain tests, to see the diff.
    else if (s.status === 'engine-bug' && !process.env.SCENARIO_SHOW_BUGS) it.fails(`${name} [suspected engine bug, see note]`, () => runScenario(s))
    else it(name, () => runScenario(s))
  }
})
