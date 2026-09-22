'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import AgentChat from './AgentChat'
import AskConsole from './AskConsole'
import { CHAT_INTENT_ID } from '@/lib/agent/ask/persist'
import AgentAvatar from './AgentAvatar'
import SandboxAgentPreview from './SandboxAgentPreview'
import { useAgentSheet } from './AgentSheetProvider'
import { useCompanyOptional } from '@/contexts/CompanyContext'

// Inline starter used by suggestion chips and ⌘K. Mirrors ChatIntakeStarter
// but accepts any intent + seed so we don't fork the intake-specific
// onboarding path. When AgentChat emits the new conversation_id, the URL
// is swapped to /chat/[id] so reload / share / browser-back all work.
export default function ChatNewStarter({
  intentId,
  seedUserMessage,
}: {
  intentId: string
  seedUserMessage?: string
}) {
  const router = useRouter()
  const { identity } = useAgentSheet()
  const companyCtx = useCompanyOptional()
  const isSandbox = companyCtx?.isSandbox ?? false
  const agentName = identity.displayName?.trim() || 'Din assistent'
  const [swapped, setSwapped] = useState(false)
  const isSingleCall = intentId === CHAT_INTENT_ID

  const swapToConversation = (id: string) => {
    // Swap once, after the turn is created. For the single-call console both
    // the question and the answer are already persisted by the time we get the
    // id back, so /chat/[id] hydrates the full thread.
    if (swapped) return
    setSwapped(true)
    router.replace(`/chat/${id}`)
  }

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-6 py-4 shrink-0">
        <AgentAvatar avatarId={identity.avatarId} size="sm" alt={agentName} />
        <div className="min-w-0">
          <h1 className="font-display text-lg tracking-tight truncate">{agentName}</h1>
          <p className="text-xs text-muted-foreground truncate">
            {isSandbox ? 'Förhandsvisning: avstängd i sandlådan' : 'Ny konversation'}
          </p>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col">
        {isSandbox ? (
          <SandboxAgentPreview agentName={agentName} />
        ) : isSingleCall ? (
          <AskConsole
            seedUserMessage={seedUserMessage}
            initialConversationId={null}
            onConversationCreated={swapToConversation}
            scrollerClassName="px-6 py-8"
          />
        ) : (
          <AgentChat
            intentId={intentId}
            seedUserMessage={seedUserMessage}
            initialMessages={[]}
            initialConversationId={null}
            onFirstTurnComplete={(id) => {
              // Wait for the first turn to finish before swapping the URL:
              // otherwise the unmount aborts the in-flight stream and
              // /chat/[id] hydrates with only the user message.
              swapToConversation(id)
            }}
            scrollerClassName="px-6 py-8"
          />
        )}
      </div>
    </>
  )
}
