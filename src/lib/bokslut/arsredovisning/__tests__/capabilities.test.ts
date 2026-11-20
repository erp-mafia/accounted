import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAnnualReportCapabilities } from '../capabilities'

afterEach(() => vi.unstubAllEnvs())

const eligible = {
  k2_eligible: true,
  digital_filing_eligible: true,
  digital_issues: [],
  size_classification: 'smaller' as const,
  k2_relief_rule: 'eligible' as const,
  issues: [],
}

describe('getAnnualReportCapabilities', () => {
  it('keeps direct filing closed unless the release gate is explicit', () => {
    vi.stubEnv('NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED', '')
    const result = getAnnualReportCapabilities('aktiebolag', 'k2', eligible)
    expect(result.paper.enabled).toBe(true)
    expect(result.ixbrl_preview.enabled).toBe(true)
    expect(result.connected_filing.enabled).toBe(false)
  })

  it('opens connected filing only when release and eligibility gates pass', () => {
    vi.stubEnv('NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED', 'true')
    const result = getAnnualReportCapabilities('aktiebolag', 'k2', eligible)
    expect(result.connected_filing.enabled).toBe(true)
  })

  it('offers no K3 iXBRL document or filing while the K3 flag is off', () => {
    vi.stubEnv('NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_K3_IXBRL_ENABLED', '')
    const result = getAnnualReportCapabilities('aktiebolag', 'k3', eligible)
    expect(result.ixbrl_preview.enabled).toBe(false)
    expect(result.ixbrl_preview.reason).toMatch(/K3/)
    expect(result.connected_filing.enabled).toBe(false)
    expect(result.connected_filing.reason).toMatch(/K3/)
  })

  it('keeps the K3 iXBRL preview closed when only the iXBRL flag is on: the K3 report is still a granskningsutkast', () => {
    vi.stubEnv('NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED', '')
    vi.stubEnv('NEXT_PUBLIC_K3_IXBRL_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED', 'true')
    const result = getAnnualReportCapabilities('aktiebolag', 'k3', eligible)
    expect(result.ixbrl_preview.enabled).toBe(false)
    expect(result.connected_filing.enabled).toBe(false)
  })

  it('opens the K3 iXBRL preview behind the K3 flag, filing still behind the release gate', () => {
    vi.stubEnv('NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_K3_IXBRL_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED', '')
    const closed = getAnnualReportCapabilities('aktiebolag', 'k3', eligible)
    expect(closed.ixbrl_preview.enabled).toBe(true)
    expect(closed.connected_filing.enabled).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED', 'true')
    expect(getAnnualReportCapabilities('aktiebolag', 'k3', eligible).connected_filing.enabled).toBe(true)
  })

  it('does not present the current K3 draft as paper-filing ready', () => {
    vi.stubEnv('NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED', '')
    const result = getAnnualReportCapabilities('aktiebolag', 'k3')
    expect(result.paper.enabled).toBe(false)
    expect(result.paper.reason).toMatch(/granskningsutkast/i)
  })

  it('offers K3 on paper once K3 is released, but not iXBRL', () => {
    vi.stubEnv('NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED', 'true')
    const result = getAnnualReportCapabilities('aktiebolag', 'k3', eligible)
    expect(result.paper.enabled).toBe(true)
    expect(result.paper.reason).toBeNull()
    expect(result.ixbrl_preview.enabled).toBe(false)
  })

  it.each(['ekonomisk_forening', 'bostadsrattsforening'] as const)(
    'keeps K3 off paper for %s, whose K3 document is not finished, flag or not',
    (entityType) => {
      vi.stubEnv('NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED', 'true')
      const result = getAnnualReportCapabilities(entityType, 'k3', eligible)
      expect(result.paper.enabled).toBe(false)
      expect(result.paper.reason).toMatch(/företagsformen/)
    },
  )

  // The form gate: the document model is AB-shaped, so a form whose profile
  // does not prepare an årsredovisning gets no PDF and no iXBRL, whatever
  // the framework or eligibility says.
  it.each(['ideell_forening', 'enskild_firma'] as const)(
    'offers neither paper nor iXBRL for %s',
    (entityType) => {
      vi.stubEnv('NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED', 'true')
      const result = getAnnualReportCapabilities(entityType, 'k2', eligible)
      expect(result.paper.enabled).toBe(false)
      expect(result.paper.reason).toMatch(/företagsformen/)
      expect(result.ixbrl_preview.enabled).toBe(false)
      expect(result.ixbrl_preview.reason).toMatch(/företagsformen/)
      expect(result.connected_filing.enabled).toBe(false)
      expect(result.connected_filing.reason).toMatch(/företagsformen/)
    },
  )

  it('treats an unknown form as not prepared, never as an aktiebolag', () => {
    const result = getAnnualReportCapabilities('handelsbolag', 'k2', eligible)
    expect(result.paper.enabled).toBe(false)
    expect(result.ixbrl_preview.enabled).toBe(false)
  })
})
