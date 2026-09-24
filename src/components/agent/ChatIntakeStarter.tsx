'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import AgentChat from './AgentChat'
import AgentAvatar from './AgentAvatar'
import SandboxAgentPreview from './SandboxAgentPreview'
import { useAgentSheet } from './AgentSheetProvider'
import { useCompanyOptional } from '@/contexts/CompanyContext'

// Phase C entry surface. Lands here from ReviewCard's "kör" after Phase B
// verify succeeds. Renders AgentChat in fresh-start mode: no
// initialConversationId, no initialMessages: so the auto-fire effect
// kicks the first invoke. As soon as /api/agent/invoke emits the
// conversation event, the URL swaps to /chat/[id] so reload / share /
// browser-back all work like any other conversation.
//
// Plan refs: §7 Phase C.
export default function ChatIntakeStarter() {
  const t = useTranslations('chat_intake_starter')
  const router = useRouter()
  const { identity } = useAgentSheet()
  const companyCtx = useCompanyOptional()
  const isSandbox = companyCtx?.isSandbox ?? false
  const agentName = identity.displayName?.trim() || t('default_agent_name')
  // Lock the swap to the first id we see: defensive guard against the
  // AgentChat callback firing twice during React 19 Strict Mode reruns.
  const [swapped, setSwapped] = useState(false)

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-6 py-4 shrink-0">
        <AgentAvatar avatarId={identity.avatarId} size="sm" alt={agentName} />
        <div className="min-w-0">
          <h1 className="font-display text-lg tracking-tight truncate">{t('ready', { name: agentName })}</h1>
          <p className="text-xs text-muted-foreground">
            {isSandbox
              ? t('sandbox_preview')
              : t('intro')}
          </p>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col">
        {isSandbox ? (
          <SandboxAgentPreview agentName={agentName} />
        ) : (
          <AgentChat
            intentId="onboarding.intake"
            initialMessages={[]}
            initialConversationId={null}
            onFirstTurnComplete={(id) => {
              // Wait for the greeting to finish streaming AND persist before
              // swapping the URL. Swapping on the early `conversation` event
              // unmounts AgentChat mid-stream, so the greeting is never saved
              // and /chat/[id] hydrates empty: the bug where the chat lands
              // blank and only shows the intro on a later visit.
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
