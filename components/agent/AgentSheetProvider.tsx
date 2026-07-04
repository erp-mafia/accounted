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
  // Intent-specific args passed to the server's intent.capture(), e.g.
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
  // Collapse hides the sheet WITHOUT unmounting it, so the in-memory
  // conversation (messages, streaming, pending approval cards) survives: the
  // floating trigger re-expands the same session. Distinct from close, which
  // ends the session entirely.
  collapseAgentSheet: () => void
  expandAgentSheet: () => void
  // Discard the current thread and start a fresh conversation on the same
  // intent (the header "Ny konversation" control). Implemented by remounting
  // the sheet via a nonce in its key.
  restartAgentSheet: () => void
  // True while a session exists (open or collapsed).
  isOpen: boolean
  // True while a session exists but is minimized off-screen.
  collapsed: boolean
  // Agent name + avatar: set once from the server-loaded agent_profile
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
  // Collapsed = session alive but hidden. Kept separate from activeArgs so
  // collapsing never unmounts AgentChat (which would wipe the conversation).
  const [collapsed, setCollapsed] = useState(false)
  // Bumped by restartAgentSheet to force a fresh AgentChat mount (a new thread)
  // on the same intent, without closing the sheet.
  const [restartNonce, setRestartNonce] = useState(0)

  const openAgentSheet = useCallback((args: OpenAgentSheetArgs) => {
    setActiveArgs(args)
    setCollapsed(false)
  }, [])

  const closeAgentSheet = useCallback(() => {
    setActiveArgs(null)
    setCollapsed(false)
  }, [])

  const collapseAgentSheet = useCallback(() => setCollapsed(true), [])
  const expandAgentSheet = useCallback(() => setCollapsed(false), [])
  const restartAgentSheet = useCallback(() => {
    setRestartNonce((n) => n + 1)
    setCollapsed(false)
  }, [])

  const resolvedIdentity = useMemo<AgentIdentity>(
    () => identity ?? { displayName: null, avatarId: null, isVerified: false },
    [identity],
  )

  const value = useMemo<AgentSheetContextValue>(
    () => ({
      openAgentSheet,
      closeAgentSheet,
      collapseAgentSheet,
      expandAgentSheet,
      restartAgentSheet,
      isOpen: activeArgs !== null,
      collapsed,
      identity: resolvedIdentity,
    }),
    [
      openAgentSheet,
      closeAgentSheet,
      collapseAgentSheet,
      expandAgentSheet,
      restartAgentSheet,
      activeArgs,
      collapsed,
      resolvedIdentity,
    ],
  )

  return (
    <AgentSheetContext.Provider value={value}>
      {children}
      {activeArgs && (
        <AgentSheet
          key={`${activeArgs.intentId}:${activeArgs.contextRef ?? ''}:${activeArgs.seedUserMessage ?? ''}:${restartNonce}`}
          intentId={activeArgs.intentId}
          intentArgs={activeArgs.intentArgs}
          contextRef={activeArgs.contextRef}
          seedUserMessage={activeArgs.seedUserMessage}
          collapsed={collapsed}
          onCollapse={collapseAgentSheet}
          onRestart={restartAgentSheet}
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
