'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import AgentChat from './AgentChat'
import AgentAvatar from './AgentAvatar'
import { useAgentSheet } from './AgentSheetProvider'

// Phase C entry surface. Lands here from ReviewCard's "kör" after Phase B
// verify succeeds. Renders AgentChat in fresh-start mode — no
// initialConversationId, no initialMessages — so the auto-fire effect
// kicks the first invoke. As soon as /api/agent/invoke emits the
// conversation event, the URL swaps to /chat/[id] so reload / share /
// browser-back all work like any other conversation.
//
// Plan refs: §7 Phase C.
export default function ChatIntakeStarter() {
  const router = useRouter()
  const { identity } = useAgentSheet()
  const agentName = identity.displayName?.trim() || 'Din assistent'
  // Lock the swap to the first id we see — defensive guard against the
  // AgentChat callback firing twice during React 19 Strict Mode reruns.
  const [swapped, setSwapped] = useState(false)

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-5 py-4 shrink-0">
        <AgentAvatar avatarId={identity.avatarId} size="sm" alt={agentName} />
        <div className="min-w-0">
          <h1 className="font-display text-lg tracking-tight truncate">{agentName} är redo</h1>
          <p className="text-xs text-muted-foreground">
            Några frågor för att lära känna din verksamhet — svara i din egen takt, du kan avsluta när du vill.
          </p>
        </div>
      </header>

      <div className="flex-1 min-h-0">
        <AgentChat
          intentId="onboarding.intake"
          initialMessages={[]}
          initialConversationId={null}
          onFirstTurnComplete={(id) => {
            // Wait for the greeting to finish streaming AND persist before
            // swapping the URL. Swapping on the early `conversation` event
            // unmounts AgentChat mid-stream, so the greeting is never saved
            // and /chat/[id] hydrates empty — the bug where the chat lands
            // blank and only shows the intro on a later visit.
            if (swapped) return
            setSwapped(true)
            router.replace(`/chat/${id}`)
          }}
          scrollerClassName="px-6 py-8"
        />
      </div>
    </>
  )
}
