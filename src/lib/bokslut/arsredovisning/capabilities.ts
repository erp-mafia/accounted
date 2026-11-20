import { flagEnabled } from '@/lib/env/public-flags'
import { k3IxbrlEnabled } from '@/lib/bokslut/ixbrl/k3-release'
import {
  isEntityType,
  preparesArsredovisning,
  supportsIxbrl,
} from '@/lib/company/entity-type'
import type { AnnualReportEligibilityResult, AnnualReportFramework } from './compliance-types'
import { k3ArsredovisningReleasedFor, k3DocumentCoversForm } from './k3-release'

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
  // A form the product prepares but no Bolagsverket taxonomy covers (an
  // ekonomisk förening) files the PDF package on paper.
  const formHasTaxonomy = formPrepared && supportsIxbrl(entityType)
  // K3 joins only behind its own default-off flag (NEXT_PUBLIC_K3_IXBRL_ENABLED,
  // lib/bokslut/ixbrl/k3-release.ts), on top of the release gate below.
  const frameworkHasDocument = framework === 'k2' || (framework === 'k3' && k3IxbrlEnabled())
  const ixbrlEnabled = formHasTaxonomy && frameworkHasDocument
  const eligible = eligibility?.digital_filing_eligible ?? false
  // K3 goes on paper once its release flag is on, and only for the form its
  // document is built for, the aktiebolag (k3-release.ts): a
  // bostadsrättsförening's or ekonomisk förening's K3 document is not finished.
  const k3FormSupported = formPrepared && k3DocumentCoversForm(entityType)
  const paperEnabled = formPrepared && (framework === 'k2' || k3ArsredovisningReleasedFor(entityType))
  return {
    paper: {
      enabled: paperEnabled,
      delivery: 'post',
      reason: !formPrepared
        ? FORM_NOT_PREPARED_REASON
        : paperEnabled
          ? null
          : !k3FormSupported
            ? 'Accounteds K3-dokument stöder ännu inte den här företagsformen.'
            : 'K3-dokumentet är ett granskningsutkast tills det har granskats av en redovisningskonsult och K3 har släppts i Accounted.',
    },
    ixbrl_preview: {
      enabled: ixbrlEnabled,
      reason: !formPrepared
        ? FORM_NOT_PREPARED_REASON
        : ixbrlEnabled
          ? null
          : !formHasTaxonomy
            ? 'iXBRL-generering stöds ännu endast för aktiebolag (taxonomin täcker inte den här företagsformen).'
            : 'Accounted skapar ännu inget iXBRL-dokument för K3-årsredovisningar.',
    },
    connected_filing: {
      enabled: releaseGateOpen && ixbrlEnabled && eligible,
      release_gate_open: releaseGateOpen,
      reason: !releaseGateOpen
        ? 'Direktinlämning öppnas först efter avtal, certifikat och godkänd acceptanstest.'
        : !formPrepared
          ? FORM_NOT_PREPARED_REASON
          : !ixbrlEnabled
            ? !formHasTaxonomy
              ? 'Direktinlämning stöds ännu endast för aktiebolag.'
              : 'Direktinlämning av K3-årsredovisningar är ännu inte öppnad.'
            : !eligible
              ? 'Årsredovisningen uppfyller inte alla behörighets- och fullständighetskrav.'
              : null,
    },
  }
}
