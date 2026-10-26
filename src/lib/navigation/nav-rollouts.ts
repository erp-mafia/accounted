import { isArkivSectionEnabled } from '@/lib/arkiv/flag'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { isInkorgV2Enabled } from '@/lib/inkorg/flag'
import { isAutogiroEnabled } from '@/lib/invoices/autogiro/flag'
import { signingSwitchedOn } from '@/lib/signing/switched-on'
import type { NavGateContext } from '@/lib/navigation/nav-gates'

/**
 * The per-company page rollouts the menu reads, resolved in one place: the
 * Dokument section, the Agenter page, the new Inkorg page and Autogiro, plus
 * the Signeringar page, which follows the signing switch. The dashboard
 * layout hands them to the sidebar and the assistant's UI map reads them for
 * its prompt, so the two cannot disagree about where a page is. Each flag
 * stays in the block that owns its page; this composition layer only
 * gathers them.
 */
export type NavRollouts = Pick<NavGateContext, 'arkivEnabled' | 'agentsEnabled' | 'inkorgV2Enabled' | 'autogiroEnabled' | 'signingEnabled'>

export function navRollouts(companyId: string | null | undefined): NavRollouts {
  return {
    arkivEnabled: isArkivSectionEnabled(companyId),
    agentsEnabled: isAgentsPageEnabled(companyId),
    inkorgV2Enabled: isInkorgV2Enabled(companyId),
    autogiroEnabled: isAutogiroEnabled(companyId),
    // Synchronous (the switch and the BankID flag); the provider itself is
    // resolved per request by GET /api/signing/availability, which the
    // page's actions follow.
    signingEnabled: signingSwitchedOn(),
  }
}
