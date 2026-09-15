import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAnnualReportCapabilities } from '../capabilities'

afterEach(() => vi.unstubAllEnvs())

describe('getAnnualReportCapabilities', () => {
  it('keeps direct filing closed unless the release gate is explicit', () => {
    vi.stubEnv('NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED', '')
    const result = getAnnualReportCapabilities('k2', {
      k2_eligible: true,
      digital_filing_eligible: true,
      digital_issues: [],
      size_classification: 'smaller',
      k2_relief_rule: 'eligible',
      issues: [],
    })
    expect(result.paper.enabled).toBe(true)
    expect(result.ixbrl_preview.enabled).toBe(true)
    expect(result.connected_filing.enabled).toBe(false)
  })

  it('opens connected filing only when release and eligibility gates pass', () => {
    vi.stubEnv('NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED', 'true')
    const result = getAnnualReportCapabilities('k2', {
      k2_eligible: true,
      digital_filing_eligible: true,
      digital_issues: [],
      size_classification: 'smaller',
      k2_relief_rule: 'eligible',
      issues: [],
    })
    expect(result.connected_filing.enabled).toBe(true)
  })

  it('keeps an ekonomisk förening on the paper package: no iXBRL, no direct filing', () => {
    vi.stubEnv('NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED', 'true')
    const result = getAnnualReportCapabilities(
      'k2',
      {
        k2_eligible: true,
        digital_filing_eligible: false,
        digital_issues: [],
        size_classification: 'smaller',
        k2_relief_rule: 'eligible',
        issues: [],
      },
      'ekonomisk_forening',
    )
    expect(result.paper.enabled).toBe(true)
    expect(result.ixbrl_preview.enabled).toBe(false)
    expect(result.ixbrl_preview.reason).toMatch(/aktiebolag/)
    expect(result.connected_filing.enabled).toBe(false)
  })

  it('does not present the current K3 draft as paper-filing ready', () => {
    const result = getAnnualReportCapabilities('k3')
    expect(result.paper.enabled).toBe(false)
    expect(result.paper.reason).toMatch(/granskningsutkast/i)
  })
})
