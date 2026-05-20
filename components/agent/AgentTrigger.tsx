'use client'

import { useAgentSheet } from './AgentSheetProvider'
import { usePathname } from 'next/navigation'
import AgentAvatar from './AgentAvatar'
import { routeToIntent } from '@/lib/agent/intents/route-mapping'

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
// "Fråga min revisor".
//
// Page-specific triggers ("Fråga om denna transaktion" on a transaction row)
// still call useAgentSheet() directly from their own buttons because they
// know exactly which row entity to pass.
export default function AgentTrigger() {
  const { openAgentSheet, isOpen, identity } = useAgentSheet()
  const pathname = usePathname()

  if (isOpen) return null
  // The /chat surface IS the chat — a floating "Fråga …" pill on top of it
  // is redundant and overlaps the input. Suppress while the user is here.
  if (pathname?.startsWith('/chat')) return null

  const name = identity.displayName?.trim() || 'min revisor'
  const dispatch = routeToIntent(pathname)
  const labelText = dispatch.labelSuffix
    ? `Fråga ${name} ${dispatch.labelSuffix}`
    : `Fråga ${name}`

  return (
    <button
      onClick={() =>
        openAgentSheet({
          intentId: dispatch.intentId,
          intentArgs: dispatch.intentArgs,
          contextRef: dispatch.contextRef,
        })
      }
      // Mobile: sit above the bottom nav (h-16 = 64px) AND the iOS home
      // indicator (env(safe-area-inset-bottom)). Desktop: standard 20px lift,
      // no mobile nav to worry about.
      className="fixed right-5 z-30 flex h-12 max-w-[calc(100vw-2.5rem)] items-center gap-2.5 rounded-full bg-foreground pl-1.5 pr-5 text-background shadow-lg hover:bg-foreground/90 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] md:bottom-5"
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
