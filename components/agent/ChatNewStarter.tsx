'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import AgentChat from './AgentChat'
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
              if (swapped) return
              setSwapped(true)
              router.replace(`/chat/${id}`)
            }}
            scrollerClassName="px-6 py-8"
          />
        )}
      </div>
    </>
  )
}
