import { flagEnabled } from '@/lib/env/public-flags'
import type { AnnualReportEligibilityResult, AnnualReportFramework } from './compliance-types'

export interface AnnualReportCapabilities {
  paper: {
    enabled: boolean
    delivery: 'post'
    reason: string | null
  }
  ixbrl_preview: {
    enabled: boolean
    reason: string | null
  }
  connected_filing: {
    enabled: boolean
    release_gate_open: boolean
    reason: string | null
  }
}

export const CONNECTED_FILING_PUBLIC_RELEASED = flagEnabled(
  process.env.NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED,
)

export function getAnnualReportCapabilities(
  framework: AnnualReportFramework,
  eligibility?: AnnualReportEligibilityResult,
): AnnualReportCapabilities {
  const releaseGateOpen = flagEnabled(process.env.NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED)
  const ixbrlEnabled = framework === 'k2'
  const eligible = eligibility?.digital_filing_eligible ?? false
  return {
    paper: {
      enabled: framework === 'k2',
      delivery: 'post',
      reason:
        framework === 'k2'
          ? null
          : 'K3-dokumentet är endast ett granskningsutkast tills hela upplysningsmatrisen är implementerad och granskad.',
    },
    ixbrl_preview: {
      enabled: ixbrlEnabled,
      reason: ixbrlEnabled ? null : 'iXBRL-generering stöds ännu endast för K2.',
    },
    connected_filing: {
      enabled: releaseGateOpen && ixbrlEnabled && eligible,
      release_gate_open: releaseGateOpen,
      reason: !releaseGateOpen
        ? 'Direktinlämning öppnas först efter avtal, certifikat och godkänd acceptanstest.'
        : !ixbrlEnabled
          ? 'Direktinlämning stöds ännu endast för K2.'
          : !eligible
            ? 'Årsredovisningen uppfyller inte alla behörighets- och fullständighetskrav.'
            : null,
    },
  }
}
