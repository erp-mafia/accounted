import { flagEnabled } from '@/lib/env/public-flags'
import { isEntityType, preparesArsredovisning } from '@/lib/company/entity-type'
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

const FORM_NOT_PREPARED_REASON =
  'Årsredovisning förbereds inte för den här företagsformen ännu.'

/**
 * What the product can hand the user for this report. The form gate comes
 * first: the document model is shaped for the forms whose profile prepares
 * an årsredovisning, so a förening must not be offered an AB-shaped PDF or
 * iXBRL just because its period closed. `entityType` is the raw model value;
 * an unknown form is treated as not prepared, never as an aktiebolag.
 */
export function getAnnualReportCapabilities(
  entityType: string,
  framework: AnnualReportFramework,
  eligibility?: AnnualReportEligibilityResult,
): AnnualReportCapabilities {
  const releaseGateOpen = flagEnabled(process.env.NEXT_PUBLIC_BOLAGSVERKET_FILING_ENABLED)
  const formPrepared = isEntityType(entityType) && preparesArsredovisning(entityType)
  const ixbrlEnabled = formPrepared && framework === 'k2'
  const eligible = eligibility?.digital_filing_eligible ?? false
  return {
    paper: {
      enabled: formPrepared && framework === 'k2',
      delivery: 'post',
      reason: !formPrepared
        ? FORM_NOT_PREPARED_REASON
        : framework === 'k2'
          ? null
          : 'K3-dokumentet är endast ett granskningsutkast tills hela upplysningsmatrisen är implementerad och granskad.',
    },
    ixbrl_preview: {
      enabled: ixbrlEnabled,
      reason: !formPrepared
        ? FORM_NOT_PREPARED_REASON
        : ixbrlEnabled
          ? null
          : 'iXBRL-generering stöds ännu endast för K2.',
    },
    connected_filing: {
      enabled: releaseGateOpen && ixbrlEnabled && eligible,
      release_gate_open: releaseGateOpen,
      reason: !releaseGateOpen
        ? 'Direktinlämning öppnas först efter avtal, certifikat och godkänd acceptanstest.'
        : !formPrepared
          ? FORM_NOT_PREPARED_REASON
          : !ixbrlEnabled
            ? 'Direktinlämning stöds ännu endast för K2.'
            : !eligible
              ? 'Årsredovisningen uppfyller inte alla behörighets- och fullständighetskrav.'
              : null,
    },
  }
}
