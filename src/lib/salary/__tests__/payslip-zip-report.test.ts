import { describe, expect, it } from 'vitest'
import {
  buildPayslipZipReport,
  payslipEmployeeLabel,
  type PayslipZipAttempt,
} from '../payslip-zip-report'

function attempts(names: string[], failing: string[] = []): PayslipZipAttempt[] {
  return names.map((name) => ({ name, ok: !failing.includes(name) }))
}

const twenty = Array.from({ length: 20 }, (_, i) => `Anställd ${i + 1}`)

describe('buildPayslipZipReport', () => {
  it('reports a fully successful batch as complete', () => {
    const report = buildPayslipZipReport(attempts(twenty))
    expect(report.outcome).toBe('complete')
    expect(report.added).toBe(20)
    expect(report.total).toBe(20)
    expect(report.failed).toBe(0)
    expect(report.missing).toEqual([])
    expect(report.missingShown).toEqual([])
    expect(report.missingOverflow).toBe(0)
  })

  it('names exactly the employees missing from a partial archive', () => {
    const failing = ['Anställd 3', 'Anställd 11', 'Anställd 20']
    const report = buildPayslipZipReport(attempts(twenty, failing))
    expect(report.outcome).toBe('partial')
    expect(report.added).toBe(17)
    expect(report.total).toBe(20)
    expect(report.failed).toBe(3)
    expect(report.missing).toEqual(failing)
    expect(report.missingShown).toEqual(failing)
    expect(report.missingOverflow).toBe(0)
  })

  it('never calls a partial archive complete, however few are missing', () => {
    // The regression this guards: the old handler counted successes only and
    // warned solely when the count reached zero, so 19 of 20 read as success.
    const report = buildPayslipZipReport(attempts(twenty, ['Anställd 7']))
    expect(report.outcome).not.toBe('complete')
    expect(report.outcome).toBe('partial')
    expect(report.missing).toEqual(['Anställd 7'])
  })

  it('keeps the missing employees in run order', () => {
    const report = buildPayslipZipReport([
      { name: 'Berg Bo', ok: false },
      { name: 'Andersson Anna', ok: true },
      { name: 'Cederlund Carl', ok: false },
    ])
    expect(report.missing).toEqual(['Berg Bo', 'Cederlund Carl'])
  })

  it('reports a batch where everything failed as none', () => {
    const report = buildPayslipZipReport(attempts(twenty, twenty))
    expect(report.outcome).toBe('none')
    expect(report.added).toBe(0)
    expect(report.failed).toBe(20)
    expect(report.missing).toHaveLength(20)
  })

  it('reports an empty run as empty rather than as a total failure', () => {
    const report = buildPayslipZipReport([])
    expect(report.outcome).toBe('empty')
    expect(report.total).toBe(0)
    expect(report.added).toBe(0)
    expect(report.failed).toBe(0)
    expect(report.missing).toEqual([])
  })

  it('truncates the displayed names but keeps the full missing list', () => {
    const report = buildPayslipZipReport(attempts(twenty, twenty.slice(0, 8)))
    expect(report.outcome).toBe('partial')
    expect(report.missing).toHaveLength(8)
    expect(report.missingShown).toHaveLength(5)
    expect(report.missingShown).toEqual(twenty.slice(0, 5))
    expect(report.missingOverflow).toBe(3)
  })

  it('honours a custom display limit', () => {
    const report = buildPayslipZipReport(attempts(twenty, twenty.slice(0, 4)), 2)
    expect(report.missingShown).toEqual(['Anställd 1', 'Anställd 2'])
    expect(report.missingOverflow).toBe(2)
  })
})

describe('payslipEmployeeLabel', () => {
  it('uses the full name when the employee relation is present', () => {
    expect(payslipEmployeeLabel('a1b2c3d4-1111', { first_name: 'Anna', last_name: 'Andersson' })).toBe(
      'Anna Andersson',
    )
  })

  it('falls back to the id prefix when the employee relation is missing', () => {
    expect(payslipEmployeeLabel('a1b2c3d4-1111')).toBe('a1b2c3d4')
    expect(payslipEmployeeLabel('a1b2c3d4-1111', null)).toBe('a1b2c3d4')
  })

  it('falls back to the id prefix when the name is blank', () => {
    expect(payslipEmployeeLabel('a1b2c3d4-1111', { first_name: '  ', last_name: null })).toBe(
      'a1b2c3d4',
    )
  })

  it('tolerates a half-filled name', () => {
    expect(payslipEmployeeLabel('a1b2c3d4-1111', { first_name: null, last_name: 'Andersson' })).toBe(
      'Andersson',
    )
  })
})
