import { isArkivBrainEnabled, isArkivSectionEnabled } from '@/lib/arkiv/flag'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { isInkorgV2Enabled } from '@/lib/inkorg/flag'
import { isAutogiroEnabled } from '@/lib/invoices/autogiro/flag'
import { signingSwitchedOn } from '@/lib/signing/switched-on'
import { isBolagetEnabled } from '@/lib/env/bolaget-switch'
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'
import { isCompanyQuestionsEnabled } from '@/lib/env/company-questions-switch'
import { assistantChatRowShown } from '@/lib/env/assistant-chat-switch'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { NavGateContext } from '@/lib/navigation/nav-gates'

/**
 * The per-company page rollouts the menu reads, resolved in one place: the
 * Dokument section, the Agenter page, the new Inkorg page and Autogiro, plus
 * the Signeringar page, which follows the signing rollout, and the built-in
 * chat, which follows the installation's own switch and its list of
 * companies that keep it. The dashboard
 * layout hands them to the sidebar and the assistant's UI map reads them for
 * its prompt, so the two cannot disagree about where a page is. Each flag
 * stays in the block that owns its page; this composition layer only
 * gathers them.
 */
export type NavRollouts = Pick<NavGateContext, 'arkivEnabled' | 'arkivBrainEnabled' | 'agentsEnabled' | 'inkorgV2Enabled' | 'autogiroEnabled' | 'signingEnabled' | 'bolagetEnabled' | 'bolagetMoneyEnabled' | 'commitmentsEnabled' | 'companyQuestionsEnabled' | 'assistantChatEnabled'>

/**
 * `bolagetRegisters`: the company row's `bolaget_registers_enabled` (a
 * company set up from a formation), which opens the register rows outside
 * the Bolaget rollout.
 */
export function navRollouts(companyId: string | null | undefined, company: { bolagetRegisters?: boolean } = {}): NavRollouts {
  return {
    arkivEnabled: isArkivSectionEnabled(companyId),
    // The Fakta view of the wiki: where Arkiv reads the documents.
    arkivBrainEnabled: !!companyId && isArkivBrainEnabled(companyId),
    agentsEnabled: isAgentsPageEnabled(companyId),
    inkorgV2Enabled: isInkorgV2Enabled(companyId),
    autogiroEnabled: isAutogiroEnabled(companyId),
    // Synchronous (the rollout and the BankID flag); the provider and the
    // plan are resolved per request by GET /api/signing/availability, which the
    // page's actions follow.
    signingEnabled: signingSwitchedOn(companyId),
    // The Bolaget section (Aktiebok, Styrelse och firmateckning).
    bolagetEnabled: isBolagetEnabled(companyId) || company.bolagetRegisters === true,
    // Möten, Kapital, Ägarskatt: the rollout alone.
    bolagetMoneyEnabled: isBolagetEnabled(companyId),
    // Avtal och åtaganden (Bolaget rollout, BOLAGET_COMPANY_IDS).
    commitmentsEnabled: commitmentsEnabledFor(companyId),
    // The question list (COMPANY_QUESTIONS_COMPANY_IDS): the Frågor row under Att göra.
    companyQuestionsEnabled: isCompanyQuestionsEnabled(companyId),
    // The Chatt row (ASSISTANT_CHAT_ENABLED): there until the chat is gone for
    // every company. Switched off, it leads a company that keeps the chat
    // (ASSISTANT_CHAT_COMPANY_IDS) to the chat and every other company to the
    // page that says what took its place.
    assistantChatEnabled: assistantChatRowShown(todayIsoStockholm()),
  }
}
