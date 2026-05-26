'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import AgentSheet from './AgentSheet'

export interface AgentIdentity {
  displayName: string | null
  avatarId: string | null
  // True only after the user has completed Phase B verification in
  // /onboarding/agent. Consumers (AgentTrigger, page-level Sparkle
  // buttons) should hide themselves when this is false so the FAB
  // doesn't pop up before the agent build flow has run.
  isVerified: boolean
}

// Provider exposes a single imperative function: openAgentSheet({...}). Any
// client component (top-nav button, transaction row "Fråga om" button, etc.)
// calls it to bring the sheet up with a specific intent + capture args.
//
// The sheet itself manages its own message list, streaming state, and
// dismissal. The provider just owns "what is open" and re-opens or replaces
// the panel when called again.

export interface OpenAgentSheetArgs {
  intentId: string
  // Intent-specific args passed to the server's intent.capture() — e.g.
  // { transaction_id: '...' } for transaction.categorization.
  intentArgs?: Record<string, unknown>
  // Optional ref persisted on agent_conversations.context_ref so the UI can
  // surface a back-pointer ("om transaktion 12 mar / 1 240 kr") later.
  contextRef?: string
  // Pre-populated first user message. When set, the chat skips the intent's
  // promptTemplate and sends this verbatim instead. Used by /chat empty-state
  // suggestion chips to give the user a one-click starting prompt.
  seedUserMessage?: string
}

interface AgentSheetContextValue {
  openAgentSheet: (args: OpenAgentSheetArgs) => void
  closeAgentSheet: () => void
  isOpen: boolean
  // Agent name + avatar — set once from the server-loaded agent_profile
  // and exposed through context so the trigger / chat headers can render
  // them without their own fetches. Null when the user hasn't verified a
  // profile yet (free tier or pre-onboarding).
  identity: AgentIdentity
}

const AgentSheetContext = createContext<AgentSheetContextValue | null>(null)

interface AgentSheetProviderProps {
  children: React.ReactNode
  identity?: AgentIdentity
}

export function AgentSheetProvider({ children, identity }: AgentSheetProviderProps) {
  const [activeArgs, setActiveArgs] = useState<OpenAgentSheetArgs | null>(null)

  const openAgentSheet = useCallback((args: OpenAgentSheetArgs) => {
    setActiveArgs(args)
  }, [])

  const closeAgentSheet = useCallback(() => {
    setActiveArgs(null)
  }, [])

  const resolvedIdentity: AgentIdentity =
    identity ?? { displayName: null, avatarId: null, isVerified: false }

  const value = useMemo<AgentSheetContextValue>(
    () => ({
      openAgentSheet,
      closeAgentSheet,
      isOpen: activeArgs !== null,
      identity: resolvedIdentity,
    }),
    [openAgentSheet, closeAgentSheet, activeArgs, resolvedIdentity],
  )

  return (
    <AgentSheetContext.Provider value={value}>
      {children}
      {activeArgs && (
        <AgentSheet
          key={`${activeArgs.intentId}:${activeArgs.contextRef ?? ''}:${activeArgs.seedUserMessage ?? ''}`}
          intentId={activeArgs.intentId}
          intentArgs={activeArgs.intentArgs}
          contextRef={activeArgs.contextRef}
          seedUserMessage={activeArgs.seedUserMessage}
          onClose={closeAgentSheet}
        />
      )}
    </AgentSheetContext.Provider>
  )
}

export function useAgentSheet(): AgentSheetContextValue {
  const ctx = useContext(AgentSheetContext)
  if (!ctx) {
    throw new Error('useAgentSheet must be used inside <AgentSheetProvider>')
  }
  return ctx
}
