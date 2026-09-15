import { describe, expect, it } from 'vitest'
import {
  activeAuditorsOn,
  evaluateAuditDependency,
  requiresQualifiedAuditor,
} from '../audit-dependency'
import {
  emptyAnnualReportProfile,
  type AnnualReportProfile,
  type AssociationAuditorSummary,
} from '../compliance-types'

const year = (employees: number | null, balance: number | null, revenue: number | null) => ({
  employees,
  balance_sheet_total: balance,
  net_revenue: revenue,
})

const auditor = (over: Partial<AssociationAuditorSummary> = {}): AssociationAuditorSummary => ({
  id: 'a1',
  name: 'Revisor Ett',
  kind: 'lekmannarevisor',
  appointed_on: '2024-05-20',
  term_ends_on: null,
  ended_on: null,
  ...over,
})

const profile = (over: Partial<AnnualReportProfile> = {}): AnnualReportProfile => ({
  ...emptyAnnualReportProfile('company-1', 'period-1'),
  auditor_report_required: true,
  ...over,
})

describe('requiresQualifiedAuditor (EFL 8 kap. 14 §)', () => {
  it('bites only when at least two of the three conditions hold in each of the two latest years', () => {
    // Two conditions both years: employees and turnover above the limits.
    expect(requiresQualifiedAuditor(year(60, 10_000_000, 90_000_000), year(55, 12_000_000, 85_000_000))).toBe(true)
    // Two conditions this year, one last year: not yet.
    expect(requiresQualifiedAuditor(year(60, 10_000_000, 90_000_000), year(55, 12_000_000, 70_000_000))).toBe(false)
    // Exactly at the limit is not "more than".
    expect(requiresQualifiedAuditor(year(50, 40_000_000, 80_000_000), year(50, 40_000_000, 80_000_000))).toBe(false)
    expect(requiresQualifiedAuditor(year(51, 40_000_001, 1), year(51, 40_000_001, 1))).toBe(true)
  })

  it('cannot bite in a first year and is unresolved when a figure is missing', () => {
    expect(requiresQualifiedAuditor(year(60, 50_000_000, 90_000_000), null)).toBe(false)
    expect(requiresQualifiedAuditor(year(null, 50_000_000, 90_000_000), year(60, 50_000_000, 90_000_000))).toBeNull()
  })
})

describe('activeAuditorsOn', () => {
  it('keeps assignments that cover the date, dropping ended and not yet appointed ones', () => {
    const roster = [
      auditor({ id: 'ended', ended_on: '2025-06-30' }),
      auditor({ id: 'future', appointed_on: '2026-05-01' }),
      auditor({ id: 'serving' }),
      auditor({ id: 'ends-on-day', ended_on: '2025-12-31' }),
    ]
    expect(activeAuditorsOn(roster, '2025-12-31').map((a) => a.id)).toEqual(['serving', 'ends-on-day'])
  })
})

describe('evaluateAuditDependency', () => {
  const base = { metrics: null, periodEndIso: '2025-12-31', stage: 'filing' as const }

  it('blocks when no revisor served on the balance-sheet date (EFL 8 kap. 1 §)', () => {
    const issues = evaluateAuditDependency({ ...base, profile: profile(), auditors: [auditor({ ended_on: '2025-01-31' })] })
    expect(issues.map((i) => i.code)).toContain('AR-EF-AUDITOR-NONE')
    expect(issues.find((i) => i.code === 'AR-EF-AUDITOR-NONE')?.severity).toBe('error')
  })

  it('demands an auktoriserad revisor once the size rule bites, and accepts a revisionsbolag', () => {
    const metrics = { current: year(60, 50_000_000, 90_000_000), previous: year(60, 50_000_000, 90_000_000) }
    const lay = evaluateAuditDependency({ ...base, metrics, profile: profile(), auditors: [auditor()] })
    expect(lay.map((i) => i.code)).toContain('AR-EF-AUDITOR-QUALIFICATION')
    const godkand = evaluateAuditDependency({ ...base, metrics, profile: profile(), auditors: [auditor({ kind: 'godkand_revisor' })] })
    expect(godkand.map((i) => i.code)).toContain('AR-EF-AUDITOR-QUALIFICATION')
    const firm = evaluateAuditDependency({ ...base, metrics, profile: profile(), auditors: [auditor({ kind: 'revisionsbolag' })] })
    expect(firm.map((i) => i.code)).not.toContain('AR-EF-AUDITOR-QUALIFICATION')
  })

  it('warns instead of guessing when a size figure is missing for one of the two years', () => {
    const metrics = { current: year(null, 50_000_000, 90_000_000), previous: year(60, 50_000_000, 90_000_000) }
    const issues = evaluateAuditDependency({ ...base, metrics, profile: profile(), auditors: [auditor()] })
    expect(issues.map((i) => i.code)).toContain('AR-EF-AUDITOR-QUALIFICATION-UNKNOWN')
    expect(issues.find((i) => i.code === 'AR-EF-AUDITOR-QUALIFICATION-UNKNOWN')?.severity).toBe('warning')
    expect(issues.map((i) => i.code)).not.toContain('AR-EF-AUDITOR-QUALIFICATION')
  })

  it('requires the archived report to carry signed date, opinion and document when it is claimed as included', () => {
    const claimed = profile({ auditor_report_included: true })
    const filing = evaluateAuditDependency({ ...base, profile: claimed, auditors: [auditor()] })
    expect(filing.map((i) => i.code)).toEqual(
      expect.arrayContaining(['AR-EF-AUDITOR-REPORT-UNSIGNED', 'AR-EF-AUDITOR-REPORT-OPINION', 'AR-EF-AUDITOR-REPORT-DOCUMENT']),
    )
    expect(filing.filter((i) => i.code.startsWith('AR-EF-AUDITOR-REPORT-')).every((i) => i.severity === 'error')).toBe(true)
    // Before filing the same gaps are warnings: the report is typically the last document in.
    const draft = evaluateAuditDependency({ ...base, stage: 'draft', profile: claimed, auditors: [auditor()] })
    expect(draft.filter((i) => i.code.startsWith('AR-EF-AUDITOR-REPORT-')).every((i) => i.severity === 'warning')).toBe(true)
    // Not claimed: nothing to check here (AR-AUDITOR-REPORT-MISSING is completeness' job).
    const unclaimed = evaluateAuditDependency({ ...base, profile: profile(), auditors: [auditor()] })
    expect(unclaimed.some((i) => i.code.startsWith('AR-EF-AUDITOR-REPORT-'))).toBe(false)
  })

  it('is silent for a complete unmodified report and warns on a modified opinion', () => {
    const complete = profile({
      auditor_report_included: true,
      auditor_report_signed_on: '2026-03-10',
      auditor_report_opinion: 'unmodified',
      auditor_report_document_id: 'doc-1',
    })
    expect(evaluateAuditDependency({ ...base, profile: complete, auditors: [auditor()] })).toEqual([])
    const qualified = evaluateAuditDependency({
      ...base,
      profile: { ...complete, auditor_report_opinion: 'qualified' },
      auditors: [auditor()],
    })
    expect(qualified).toHaveLength(1)
    expect(qualified[0]).toMatchObject({ code: 'AR-EF-AUDITOR-REPORT-MODIFIED', severity: 'warning' })
    expect(qualified[0].remediation).toBeDefined()
    const explained = evaluateAuditDependency({
      ...base,
      profile: { ...complete, auditor_report_opinion: 'qualified', auditor_report_deviations: 'Lager ej inventerat.' },
      auditors: [auditor()],
    })
    expect(explained[0].remediation).toBeUndefined()
  })
})
