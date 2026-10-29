import { isArkivSectionEnabled } from '@/lib/arkiv/flag'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { isInkorgV2Enabled } from '@/lib/inkorg/flag'
import { isAutogiroEnabled } from '@/lib/invoices/autogiro/flag'
import { signingSwitchedOn } from '@/lib/signing/switched-on'
import { isBolagetEnabled } from '@/lib/env/bolaget-switch'
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'
import type { NavGateContext } from '@/lib/navigation/nav-gates'

/**
 * The per-company page rollouts the menu reads, resolved in one place: the
 * Dokument section, the Agenter page, the new Inkorg page and Autogiro, plus
 * the Signeringar page, which follows the signing rollout. The dashboard
 * layout hands them to the sidebar and the assistant's UI map reads them for
 * its prompt, so the two cannot disagree about where a page is. Each flag
 * stays in the block that owns its page; this composition layer only
 * gathers them.
 */
export type NavRollouts = Pick<NavGateContext, 'arkivEnabled' | 'agentsEnabled' | 'inkorgV2Enabled' | 'autogiroEnabled' | 'signingEnabled' | 'bolagetEnabled' | 'commitmentsEnabled'>

export function navRollouts(companyId: string | null | undefined): NavRollouts {
  return {
    arkivEnabled: isArkivSectionEnabled(companyId),
    agentsEnabled: isAgentsPageEnabled(companyId),
    inkorgV2Enabled: isInkorgV2Enabled(companyId),
    autogiroEnabled: isAutogiroEnabled(companyId),
    // Synchronous (the rollout and the BankID flag); the provider and the
    // plan are resolved per request by GET /api/signing/availability, which the
    // page's actions follow.
    signingEnabled: signingSwitchedOn(companyId),
    // The Bolaget section (Ägare och aktiebok, Styrelse och firmateckning).
    bolagetEnabled: isBolagetEnabled(companyId),
    // Avtal och åtaganden (Bolaget rollout, BOLAGET_COMPANY_IDS).
    commitmentsEnabled: commitmentsEnabledFor(companyId),
  }
}
