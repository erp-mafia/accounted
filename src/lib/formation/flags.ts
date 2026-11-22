/**
 * FORMATION_SHAREHOLDER_AGREEMENT_ENABLED: the aktieägaravtal template in
 * the formation package. Off until a lawyer has read the template (the
 * formation plan's condition); every other document is on with the feature.
 */
import { flagEnabled } from '@/lib/env/public-flags'

export function shareholderAgreementEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagEnabled(env.FORMATION_SHAREHOLDER_AGREEMENT_ENABLED)
}
