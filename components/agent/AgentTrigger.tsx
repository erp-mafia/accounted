'use client'

import { useAgentSheet } from './AgentSheetProvider'
import { usePathname, useRouter } from 'next/navigation'
import AgentAvatar from './AgentAvatar'
import { routeToIntent } from '@/lib/agent/intents/route-mapping'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'

// Floating trigger sits above the page bottom-right, opens the AgentSheet when
// clicked. Hidden when the sheet is already open so the icon doesn't double up.
//
// Route-aware: routeToIntent(pathname) picks the right intent + intentArgs so
// clicking the FAB on /invoices/abc-123 opens invoice.draft with that invoice
// id (rather than the page-agnostic general.help with just the URL). The
// label suffix renders "Fråga Anna om denna faktura" so the user can tell at
// a glance that the agent is going to know which entity they're on.
//
// Reads the agent's display_name + avatar_id from the AgentSheet context so
// the button reads "Fråga Anna" (with Anna's face) rather than the generic
// "Fråga min assistent".
//
// Page-specific triggers (e.g. "Granska med assistent" on a supplier invoice)
// still call useAgentSheet() directly from their own buttons because they
// know exactly which entity to pass. (Per-transaction help has its own
// row-level "Fråga [namn]" button in TransactionInboxCard, and the matching
// "Fråga assistenten" in Dokumentinkorgen: both passing a transaction_id the
// pathname-only FAB can't know.)
export default function AgentTrigger() {
  const { openAgentSheet, expandAgentSheet, isOpen, collapsed, identity } = useAgentSheet()
  const pathname = usePathname()
  const router = useRouter()
  const hasAi = useCapability(CAPABILITY.ai)

  // Sheet open AND visible → hide the FAB so the icon doesn't double up. When
  // the session is merely collapsed we KEEP the FAB: it's the handle that
  // brings the minimized conversation back.
  if (isOpen && !collapsed) return null
  // The page-suppression rules below apply only to a FRESH open. A collapsed
  // session always gets its reopen handle, regardless of page: otherwise a
  // conversation minimized on /chat or /bookkeeping/[id] could never be
  // brought back.
  if (!collapsed) {
    // The /chat surface IS the chat: a floating "Fråga …" pill on top of it
    // is redundant and overlaps the input. Suppress while the user is here.
    if (pathname?.startsWith('/chat')) return null
    // The verifikation editor is a dense regulatory surface (debits/credits,
    // BAS codes, period locks): a floating "Fråga … om denna verifikation"
    // pill on top of it adds noise without earning its place. Suppress on
    // /bookkeeping/[id] specifically; /bookkeeping (list), /bookkeeping/new,
    // and /bookkeeping/year-end still get the FAB.
    const segs = pathname?.split('/').filter(Boolean) ?? []
    if (segs[0] === 'bookkeeping' && segs[1] && segs[1] !== 'year-end' && segs[1] !== 'new') {
      return null
    }
  }
  // Pre-onboarding: no agent_profile.verified_at yet. The FAB would lead
  // into a generic chat with no specialization. Better to hide it until
  // the user has finished /onboarding/agent. (A collapsed session implies the
  // agent is already in use, so this only gates fresh opens in practice.)
  if (!identity.isVerified) return null

  const name = identity.displayName?.trim() || 'min assistent'
  const dispatch = routeToIntent(pathname)
  // AI assistant runs on a paid cloud service. Without the capability, opening
  // the sheet would land the user in a chat whose send is dead. Keep the FAB
  // visible (it's the conversion surface) but route it to billing instead.
  const labelText = collapsed
    ? `Fortsätt med ${name}`
    : !hasAi
      ? `Uppgradera för att använda ${name}`
      : dispatch.labelSuffix
        ? `Fråga ${name} ${dispatch.labelSuffix}`
        : `Fråga ${name}`

  const handleClick = () => {
    // Collapsed → bring the existing session back, don't start a new one.
    if (collapsed) {
      expandAgentSheet()
      return
    }
    if (!hasAi) {
      router.push('/settings/billing')
      return
    }
    openAgentSheet({
      intentId: dispatch.intentId,
      intentArgs: dispatch.intentArgs,
      contextRef: dispatch.contextRef,
    })
  }

  return (
    <button
      onClick={handleClick}
      // Mobile: sit above the bottom nav (h-16 = 64px) AND the iOS home
      // indicator (env(safe-area-inset-bottom)). Desktop: standard 20px lift,
      // no mobile nav to worry about.
      className="fixed right-4 z-30 flex h-12 max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full bg-foreground pl-2 pr-4 text-background shadow-lg hover:bg-foreground/90 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] md:bottom-4"
      aria-label={labelText}
    >
      <AgentAvatar
        avatarId={identity.avatarId}
        size="sm"
        className="ring-2 ring-background/20 shrink-0"
        alt={name}
      />
      <span className="text-sm font-medium truncate">{labelText}</span>
    </button>
  )
}
